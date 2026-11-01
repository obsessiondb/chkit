import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ClickHouseExecutor, ClickHouseSettings } from '@chkit/clickhouse'
import { quoteIdentifier } from '@chkit/core'

import { BATCH_ID_COLUMN, INGESTED_AT_COLUMN, RUN_ID_COLUMN, toJsonRows } from './destination.js'
import { IngestConfigError } from './errors.js'
import type { LoaderFactory, Row, SinkReceipt } from './types.js'

/**
 * SQL capabilities used by stagedLoader; the ordinary destination remains insert-only.
 * Methods must honor supplied settings. In particular submit with wait_end_of_query=1
 * and send_progress_in_http_headers=0 must await the final server response, not enqueue.
 */
export type StagedLoaderExecutor = Pick<ClickHouseExecutor, 'command' | 'query' | 'insert' | 'submit'>

export interface StagedLoaderOptions {
  /** One shared, stateless executor pinned to one server. Do not use a load-balanced endpoint. */
  executor: StagedLoaderExecutor
  /** Nonempty identity of an immutable observation, e.g. ['account_id', 'id', 'version']. */
  keys: readonly string[]
  /** First/last row in the reader's ordered batch wins within staging. Existing destination keys always win. */
  winner: 'first' | 'last'
  /** Explicitly accept the single-process, single-executor publication contract described below. */
  concurrency: 'single-process'
  /** Positive integer, default 50,000. Only changes physical staging INSERTs, not logical identity. */
  maxRowsPerInsert?: number
  /** Maximum reconciliation wait per attempt; default 30,000 ms, at most 2,147,483,647 ms. */
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
// A successful truncated sort/read or incomplete join would turn resource limits
// into checkpointed omissions or duplicates. Keep limits, but require failure.
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
 * Opt-in insert-if-absent publication of immutable observations into a plain
 * MergeTree table. Stages each logical batch, selects one ordered winner per
 * explicit key, then filters keys already present in the destination. Unlike
 * simpleLoader's finite native INSERT-token window, this policy uses retained
 * destination rows and survives physical insert resizing and overlapping reads.
 *
 * Identity is NOT an update policy: ['id'] keeps the first published entity
 * forever while it remains present. Include a version/content hash to retain
 * changes. `winner` only chooses within this batch; ties use reader order, which
 * must be stable on replay. Keys must be present, non-null scalar columns;
 * equality uses their stored ClickHouse types. No upserts or deletions occur.
 *
 * All writers must use stagedLoader with the same identity policy and share
 * this executor object in one loaded package/process,
 * pinned to one server with read-your-writes visibility. Publication is locally
 * serialized, but an anti-join is NOT cross-process atomic uniqueness. Do not
 * overlap processes, external writers or schema changes. Replicated, Shared,
 * Distributed and replacing engines are rejected. Before restarting after a
 * crash, stop/wait for old server queries; no distributed recovery fence exists.
 *
 * A receipt follows publication, never staging. A missing ACK is reconciled via
 * terminal query-log evidence; unresolved queries fence later publication and retain scratch.
 * Cancellation may leave published rows, but must not commit progress. Retrying
 * after a terminal partial failure fills missing keys, not a transactional batch.
 * Cleanup failures throw; crash orphans require operator cleanup after quiescence.
 *
 * Prefer simpleLoader for cheap append-only writes, or replacing/current-state
 * storage (and appropriate reads) for updates. This loader adds per-batch DDL,
 * scratch writes/storage, sorting and destination key reads (potentially a full
 * scan), another INSERT and cleanup: higher latency and server/client cost.
 * It does not repair preexisting duplicates or guarantee downstream view effects.
 * Ordinary defaults resolve in scratch; generated columns and ingestion time
 * are evaluated again at the destination. Supply explicit stable values when
 * nondeterministic defaults must not change on replay.
 *
 * @example
 * const loader = stagedLoader({
 *   executor, keys: ['account_id', 'event_id', 'version'],
 *   winner: 'first', concurrency: 'single-process', maxRowsPerInsert: 10_000,
 * })
 * // Reuse executor and loader across every stream targeting this server.
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
        // DEFAULT expressions can reference aliases, materialized columns or
        // ingestion time. Keep those dependencies in scratch, but never include
        // generated columns or the staged ingestion time in the publication list.
        const definitions = schema.map((column) => `${quoteIdentifier(column.name)} ${column.type}${column.default_type ? ` ${column.default_type} ${column.default_expression}` : ''}`)
        // No IF NOT EXISTS or batch-derived name: another attempt's scratch must
        // never become ours. A lost CREATE ACK can leave an orphan, not ownership.
        await executor.command(`CREATE TABLE ${staging} UUID ${literal(scratch.uuid)} (${definitions.join(', ')}, ${quoteIdentifier(ORDINAL)} UInt64) ENGINE = MergeTree ORDER BY tuple()`)
        created = true
        for (let offset = 0; offset < batch.rows.length; offset += maxRows) {
          ctx.signal.throwIfAborted()
          const values = batch.rows.slice(offset, offset + maxRows).map((row, index) => {
            const { [INGESTED_AT_COLUMN]: _ignored, ...authored } = row
            return { ...authored, [BATCH_ID_COLUMN]: batch.batchId, [RUN_ID_COLUMN]: ctx.runId, [ORDINAL]: offset + index }
          })
          // Fresh scratch is discarded on any failed write. Native block tokens
          // must not suppress different rows when retry slicing changes.
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
          // LIMIT BY follows a total input-ordinal ordering. Restrict the join
          // build to keys from this batch, not the entire destination. Both
          // sides have identical non-null native types; a truncated IN set would
          // hide existing keys, so set_overflow_mode must remain throw. This can
          // reduce join memory without avoiding a full destination-key scan.
          const sql = `INSERT INTO ${destination} (${projected})`
            + ` SELECT ${columns.map((column) => `s.${quoteIdentifier(column.name)}`).join(', ')}`
            + ` FROM (SELECT ${projected} FROM ${staging} ORDER BY ${quoteIdentifier(ORDINAL)} ${winner === 'first' ? 'ASC' : 'DESC'} LIMIT 1 BY ${identity}) AS s`
            + ` LEFT ANTI JOIN (SELECT ${identity} FROM ${destination} WHERE tuple(${identity}) IN (SELECT tuple(${identity}) FROM ${staging})) AS d`
            + ` ON ${keys.map((key) => `s.${quoteIdentifier(key)} = d.${quoteIdentifier(key)}`).join(' AND ')}`
          const queryId = `chkit-stage-${randomUUID()}`
          gate.pending = { queryId, scratch }
          try {
            // The query id identifies this physical operation, NOT the batch.
            // Anti-filtered replay has different contents, so native INSERT
            // deduplication must be off. Submission here waits for completion.
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
        // An HTTP error/abort does not stop server SQL. Keep its source table
        // until terminal evidence exists; the next publication reconciles first.
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
        // Bound observation, not server execution. Abandoning a hung status read
        // leaves the fence intact. Unique ids need no client-clock time filter.
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
    // Cleanup is not observation: a DROP failure must not misreport positively
    // terminal publication as unknown, or claim that its cleared fence remains.
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
