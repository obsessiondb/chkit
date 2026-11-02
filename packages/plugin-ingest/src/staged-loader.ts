import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ClickHouseExecutor, ClickHouseSettings } from '@chkit/clickhouse'
import { quoteIdentifier } from '@chkit/core'

import { BATCH_ID_COLUMN, INGESTED_AT_COLUMN, RUN_ID_COLUMN, toJsonRows } from './destination.js'
import { IngestConfigError } from './errors.js'
import type { LoaderFactory, Row, SinkReceipt } from './types.js'

/**
 * - Explicit SQL access for stagedLoader; the ordinary destination stays insert-only.
 * - Honor supplied settings and return complete results; synchronous submit must await
 *   the final response (`wait_end_of_query=1`, `send_progress_in_http_headers=0`).
 */
export type StagedLoaderExecutor = Pick<ClickHouseExecutor, 'command' | 'query' | 'insert' | 'submit'>

export interface StagedLoaderOptions {
  /** - Shared stateless executor pinned to one server, never a load balancer. */
  executor: StagedLoaderExecutor
  /** - Explicit immutable-observation identity, e.g. ['account_id', 'id', 'version']. */
  keys: readonly string[]
  /** - First/last whole row in batch order wins; existing destination keys always win. */
  winner: 'first' | 'last'
  /** - Accept the single-process/shared-executor publication contract below. */
  concurrency: 'single-process'
  /** - Positive integer; default 50,000. Sizes scratch INSERTs, not logical batches. */
  maxRowsPerInsert?: number
  /** - Per-attempt reconciliation wait, not SQL timeout; default 30,000 ms, max 2,147,483,647. */
  reconciliationTimeoutMs?: number
}

interface Column {
  name: string
  type: string
  default_type: string
  default_expression: string
}

interface Scratch {
  database: string
  name: string
  uuid: string
}

interface PublicationGate {
  tail: Promise<void>
  pending?: { queryId: string; scratch: Scratch }
}

const ORDINAL = '_chkit_stage_ordinal'
const gates = new WeakMap<StagedLoaderExecutor, Map<string, PublicationGate>>()
// Truncated results would checkpoint omissions or duplicates; resource limits must throw.
const STRICT_RESULTS = {
  read_overflow_mode: 'throw',
  read_overflow_mode_leaf: 'throw',
  sort_overflow_mode: 'throw',
  join_overflow_mode: 'throw',
  set_overflow_mode: 'throw',
  timeout_overflow_mode: 'throw',
  timeout_overflow_mode_leaf: 'throw',
  result_overflow_mode: 'throw',
} satisfies ClickHouseSettings

/**
 * - Opt-in insert-if-absent for immutable observations across overlaps/replays,
 *   independent of native token retention. Prefer simpleLoader for cheap appends.
 * - Explicit non-null scalar keys use stored ClickHouse equality. Include a version/hash
 *   to retain changes; entity keys discard updates. Not an upsert or deletion reconciler.
 * - First/last selects one whole row per key within the ordered batch; keep replay order
 *   stable. Existing keys always win; existing duplicates are not repaired.
 * - Only plain MergeTree/Atomic on one pinned server. All writers must share the executor,
 *   identity policy and staged gate in one package/process; no external writes/schema changes.
 *   No Shared, replicated, Distributed or replacing engines; no cross-process uniqueness.
 * - Receipts follow publication, never staging. Unknown publication retains scratch and
 *   fences later publication until terminal query-log evidence; cancellation cannot undo writes.
 *   Before restart, quiesce old publishers and wait for/terminate their server queries.
 * - Costs: per-batch DDL, scratch storage/writes, sorting, possible full destination-key scans.
 *   Full scratch schema resolves DEFAULT dependencies at staging; generated columns and
 *   ingestion time recompute at publication. Materialized work/storage can occur twice.
 * - Partial failures replay missing keys, not a transaction or downstream-view repair.
 *   Cleanup failures throw; remove crash orphans only after writer quiescence.
 * - Setup, default timing and recovery: https://chkit.obsessiondb.com/api-sync/loading/
 */
export function stagedLoader(options: StagedLoaderOptions): LoaderFactory {
  const { executor, winner } = options
  if (!Array.isArray(options.keys)) throw new IngestConfigError('stagedLoader requires explicit keys')
  const keys = [...options.keys]
  const maxRows = options.maxRowsPerInsert ?? 50_000
  const timeoutMs = options.reconciliationTimeoutMs ?? 30_000
  if (keys.length === 0 || keys.some((key) => typeof key !== 'string' || !key.trim() || key.startsWith('_chkit_')) || new Set(keys).size !== keys.length) {
    throw new IngestConfigError('stagedLoader requires distinct, nonempty, non-metadata keys')
  }
  if (winner !== 'first' && winner !== 'last') throw new IngestConfigError('stagedLoader winner must be first or last')
  if (options.concurrency !== 'single-process') throw new IngestConfigError('stagedLoader requires concurrency: single-process')
  for (const [name, value] of [['maxRowsPerInsert', maxRows], ['reconciliationTimeoutMs', timeoutMs]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new IngestConfigError(`stagedLoader ${name} must be a positive safe integer`)
  }
  if (timeoutMs > 2_147_483_647) throw new IngestConfigError('stagedLoader reconciliationTimeoutMs must be at most 2147483647 ms (the Node timer limit)')

  return (ctx) => {
    for (const key of keys) {
      const column = ctx.table.columns.find((column) => column.name === key)
      if (!column || !isKeyType(column.type)) throw new IngestConfigError(`stagedLoader key ${key} must be a supported non-null scalar column`)
    }
    if (ctx.table.columns.some((column) => column.type.startsWith('Nested(') || column.defaultKind === 'EPHEMERAL')) {
      throw new IngestConfigError('stagedLoader does not support Nested or EPHEMERAL columns')
    }
    const destination = qualified(ctx.table.database, ctx.table.name)
    const gate = publicationGate(executor, destination)
    const scratch: Scratch = { database: ctx.table.database, name: `_chkit_stage_${randomUUID().replaceAll('-', '')}`, uuid: randomUUID() }
    const staging = qualified(scratch.database, scratch.name)
    let created = false
    let writeStarted = false
    let written = false
    let aborted = false
    let columns: Column[] = []
    let inputRows = 0
    let receipt: SinkReceipt | undefined

    return {
      ctx,
      async write(batch) {
        if (writeStarted || aborted) throw new Error('stagedLoader accepts one write per batch attempt')
        writeStarted = true
        ctx.signal.throwIfAborted()
        for (const row of batch.rows) validateKeys(row, keys)
        inputRows = batch.rows.length
        if (inputRows === 0) {
          written = true
          return
        }
        const schema = await describeDestination(executor, ctx.table.database, ctx.table.name, keys)
        columns = schema.filter((column) => column.name !== INGESTED_AT_COLUMN && (!column.default_type || column.default_type === 'DEFAULT'))
        ctx.signal.throwIfAborted()
        // DEFAULT dependencies need the full schema; generated columns/time stay out of publication.
        const definitions = schema.map((column) => `${quoteIdentifier(column.name)} ${column.type}${column.default_type ? ` ${column.default_type} ${column.default_expression}` : ''}`)
        // A lost CREATE ACK leaves an orphan, not ownership of a later attempt's scratch.
        await executor.command(`CREATE TABLE ${staging} UUID ${literal(scratch.uuid)} (${definitions.join(', ')}, ${quoteIdentifier(ORDINAL)} UInt64) ENGINE = MergeTree ORDER BY tuple()`)
        created = true
        for (let offset = 0; offset < batch.rows.length; offset += maxRows) {
          ctx.signal.throwIfAborted()
          const values = batch.rows.slice(offset, offset + maxRows).map((row, index) => {
            const { [INGESTED_AT_COLUMN]: _ignored, ...authored } = row
            return { ...authored, [BATCH_ID_COLUMN]: batch.batchId, [RUN_ID_COLUMN]: ctx.runId, [ORDINAL]: offset + index }
          })
          // Native tokens must not suppress rows when retry slicing changes.
          await executor.insert({ table: staging, values: toJsonRows(values), settings: {
            ...STRICT_RESULTS,
            async_insert: 0, wait_for_async_insert: 1, insert_deduplicate: 0,
            input_format_allow_errors_num: '0', input_format_allow_errors_ratio: 0,
          } })
        }
        ctx.signal.throwIfAborted()
        written = true
      },
      async finalize() {
        if (!written || aborted) throw new Error('stagedLoader must write before finalizing and cannot finalize after abort')
        ctx.signal.throwIfAborted()
        if (receipt) return receipt
        if (inputRows === 0) return { evidence: 'none_required', rows: 0, writeUnits: 0 }
        const previous = gate.tail
        let release = () => {}
        gate.tail = new Promise<void>((resolve) => { release = resolve })
        try {
          await previous
          ctx.signal.throwIfAborted()
          if (gate.pending) {
            await reconcile(executor, gate, timeoutMs, ctx.signal)
          }
          const projected = columns.map((column) => quoteIdentifier(column.name)).join(', ')
          const identity = keys.map(quoteIdentifier).join(', ')
          // Ordinals select whole-row winners; candidate keys bound join memory, not scan work.
          const sql = `INSERT INTO ${destination} (${projected})`
            + ` SELECT ${columns.map((column) => `s.${quoteIdentifier(column.name)}`).join(', ')}`
            + ` FROM (SELECT ${projected} FROM ${staging} ORDER BY ${quoteIdentifier(ORDINAL)} ${winner === 'first' ? 'ASC' : 'DESC'} LIMIT 1 BY ${identity}) AS s`
            + ` LEFT ANTI JOIN (SELECT ${identity} FROM ${destination} WHERE tuple(${identity}) IN (SELECT tuple(${identity}) FROM ${staging})) AS d`
            + ` ON ${keys.map((key) => `s.${quoteIdentifier(key)} = d.${quoteIdentifier(key)}`).join(' AND ')}`
          const queryId = `chkit-stage-${randomUUID()}`
          gate.pending = { queryId, scratch }
          try {
            // Replayed anti-joins can change contents: use a fresh query id and no native dedup.
            await executor.submit(sql, queryId, {
              ...STRICT_RESULTS,
              wait_end_of_query: 1, send_progress_in_http_headers: 0, async_insert: 0, insert_deduplicate: 0,
              log_queries: 1, log_queries_probability: 1, log_queries_min_query_duration_ms: 0, log_queries_min_type: 'QUERY_START',
            })
          } catch (error) {
            const status = await reconcile(executor, gate, timeoutMs, ctx.signal)
            if (status === 'failed') throw error
          }
          gate.pending = undefined
          ctx.signal.throwIfAborted()
          await dropOwnedScratch(executor, scratch)
          created = false
          ctx.signal.throwIfAborted()
          receipt = { evidence: 'clickhouse_ack', rows: inputRows, writeUnits: 1 }
          return receipt
        } finally {
          release()
        }
      },
      async abort() {
        aborted = true
        // An HTTP abort may leave server SQL running; retain its scratch until terminal evidence.
        if (created && gate.pending?.scratch.uuid !== scratch.uuid) {
          await dropOwnedScratch(executor, scratch)
          created = false
        }
      },
    }
  }
}

async function describeDestination(executor: StagedLoaderExecutor, database: string, name: string, keys: readonly string[]): Promise<Column[]> {
  const [tables, columns] = await Promise.all([
    executor.query<{ engine: string; database_engine: string }>(`SELECT t.engine, d.engine AS database_engine FROM system.tables AS t INNER JOIN system.databases AS d ON t.database = d.name WHERE t.database = ${literal(database)} AND t.name = ${literal(name)}`, STRICT_RESULTS),
    executor.query<Column>(`DESCRIBE TABLE ${qualified(database, name)}`, STRICT_RESULTS),
  ])
  if (tables[0]?.engine !== 'MergeTree' || tables[0]?.database_engine !== 'Atomic') {
    throw new IngestConfigError('stagedLoader requires a plain MergeTree table in an Atomic database on one pinned server')
  }
  if (columns.some((column) => column.default_type === 'EPHEMERAL' || column.name === ORDINAL || column.name.includes('.'))) {
    throw new IngestConfigError('stagedLoader does not support EPHEMERAL, Nested/dotted or reserved ordinal columns')
  }
  for (const key of keys) {
    const column = columns.find((column) => column.name === key)
    if (!column || !isKeyType(column.type) || (column.default_type && column.default_type !== 'DEFAULT')) {
      throw new IngestConfigError(`stagedLoader key ${key} must be a stored, writable non-null scalar column`)
    }
  }
  for (const name of [BATCH_ID_COLUMN, RUN_ID_COLUMN, INGESTED_AT_COLUMN]) {
    if (!columns.some((column) => column.name === name)) throw new IngestConfigError(`stagedLoader destination is missing ${name}; include ingestionColumns`)
  }
  for (const name of [BATCH_ID_COLUMN, RUN_ID_COLUMN]) {
    const column = columns.find((column) => column.name === name)
    if (column?.type !== 'String' || (column.default_type && column.default_type !== 'DEFAULT')) {
      throw new IngestConfigError(`stagedLoader ${name} must be a writable String; include ingestionColumns`)
    }
  }
  const ingestedAt = columns.find((column) => column.name === INGESTED_AT_COLUMN)
  if (ingestedAt?.type !== "DateTime64(6, 'UTC')" || ingestedAt.default_type !== 'DEFAULT' || !["now64(6)", "now64(6,'UTC')"].includes(ingestedAt.default_expression.replaceAll(' ', ''))) {
    throw new IngestConfigError(`stagedLoader ${INGESTED_AT_COLUMN} must retain its publication-time default; include ingestionColumns unchanged`)
  }
  return columns
}

async function reconcile(executor: StagedLoaderExecutor, gate: PublicationGate, timeoutMs: number, signal: AbortSignal): Promise<'finished' | 'failed'> {
  const pending = gate.pending
  if (!pending) throw new Error('stagedLoader has no publication to reconcile')
  const deadline = Date.now() + timeoutMs
  let terminal: 'finished' | 'failed' | undefined
  try {
    do {
      signal.throwIfAborted()
      const timer = new AbortController()
      let events: { type: string }[]
      try {
        // A status-read timeout leaves the fence intact; it does not stop server SQL.
        events = await Promise.race([
          executor.query<{ type: string }>(`SELECT type FROM system.query_log WHERE query_id = ${literal(pending.queryId)} AND user = currentUser() AND is_initial_query = 1 AND type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart') LIMIT 1`, STRICT_RESULTS),
          sleep(Math.max(1, deadline - Date.now()), undefined, { signal: AbortSignal.any([signal, timer.signal]) }).then(() => { throw new Error('terminal observation timed out') }),
        ])
      } finally {
        timer.abort()
      }
      signal.throwIfAborted()
      const event = events[0]?.type
      if (event === 'QueryFinish' || event === 'ExceptionWhileProcessing' || event === 'ExceptionBeforeStart') {
        gate.pending = undefined
        terminal = event === 'QueryFinish' ? 'finished' : 'failed'
        break
      }
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal })
    } while (Date.now() < deadline)
  } catch (cause) {
    throw new Error(`stagedLoader could not reconcile publication ${pending.queryId}; do not start another publisher until terminal evidence is available. Scratch: ${qualified(pending.scratch.database, pending.scratch.name)}`, { cause })
  }
  if (terminal) {
    // Cleanup failure must not misreport terminal publication as unknown or still fenced.
    await dropOwnedScratch(executor, pending.scratch)
    return terminal
  }
  throw new Error(`stagedLoader publication ${pending.queryId} is unresolved; publication remains fenced. Wait for terminal query status before retrying; do not start another process. Scratch: ${qualified(pending.scratch.database, pending.scratch.name)}`)
}

async function dropOwnedScratch(executor: StagedLoaderExecutor, scratch: Scratch): Promise<void> {
  try {
    const rows = await executor.query<{ uuid: string }>(`SELECT toString(uuid) AS uuid FROM system.tables WHERE database = ${literal(scratch.database)} AND name = ${literal(scratch.name)}`, STRICT_RESULTS)
    if (rows.length === 0) return
    if (rows[0]?.uuid !== scratch.uuid) throw new Error('stagedLoader refuses to drop scratch with changed ownership')
    await executor.command(`DROP TABLE ${qualified(scratch.database, scratch.name)} SYNC`)
  } catch (cause) {
    throw new Error(`stagedLoader scratch cleanup failed for ${qualified(scratch.database, scratch.name)}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

function publicationGate(executor: StagedLoaderExecutor, destination: string): PublicationGate {
  let byTable = gates.get(executor)
  if (!byTable) {
    byTable = new Map()
    gates.set(executor, byTable)
  }
  let gate = byTable.get(destination)
  if (!gate) {
    gate = { tail: Promise.resolve() }
    byTable.set(destination, gate)
  }
  return gate
}

function validateKeys(row: Row, keys: readonly string[]): void {
  for (const key of keys) {
    const value = row[key]
    if (!Object.hasOwn(row, key) || value === null || value === undefined || !['string', 'number', 'bigint', 'boolean'].includes(typeof value)) {
      throw new IngestConfigError(`stagedLoader row requires a non-null scalar key: ${key}`)
    }
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new IngestConfigError(`stagedLoader numeric key ${key} must be a safe integer; use an exact string or bigint`)
    }
  }
}

function isKeyType(type: string): boolean {
  const scalar = type.replace(/^LowCardinality\((.*)\)$/, '$1')
  return /^(String|FixedString\(\d+\)|U?Int(8|16|32|64|128|256)|UUID|IPv[46]|Date|Date32|DateTime(?:\('[^']+'\))?|DateTime64\(\d+(?:,\s*'[^']+')?\))$/.test(scalar)
}

function qualified(database: string, name: string): string {
  return `${quoteIdentifier(database)}.${quoteIdentifier(name)}`
}

function literal(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}
