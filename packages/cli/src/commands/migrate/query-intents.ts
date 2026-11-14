import { randomUUID } from 'node:crypto'

import type { ClickHouseExecutor, ClickHouseSettings } from '@chkit/clickhouse'
import { identifierName, isTrivia, quoteIdentifier, statementFingerprint, tokenizeSQL, type SQLToken } from '@chkit/core'

import type { RecoveryObligation } from './cancellation.js'

import { CLI_VERSION } from '../../runtime/version.js'
import { MigrateError } from './errors.js'
import type { LockTarget, MigrateLock } from './lock.js'

export const QUERY_INTENT_PREFIX = '__chkit_migrate_query__/'
/** Suffix of the row that marks a claim as having run untracked statements. */
export const UNTRACKED = 'untracked'

const CANCELLABLE_SETTINGS = new Set(['max_threads', 'max_insert_threads', 'max_block_size', 'max_insert_block_size', 'min_insert_block_size_rows', 'min_insert_block_size_bytes', 'async_insert'])

/** The effective SQL identity and verified topology, shared by both ports. */
export interface QueryIdentity {
  protocol: 1
  principal: string
  serverUUIDs: string[]
  cluster?: string
}

export interface QueryContext {
  migration: string
  statementIndex: number
  forwardSQL: string
  beforeRetry: string | null
}

export type QueryPhase = 'forward' | 'compensation'
export interface QueryTarget { database: string; name: string; uuid?: string; engine?: string }
export type QueryKind = 'insert' | 'replace' | 'async' | 'unsupported'

/** Immutable checksum JSON; never contains SQL or credentials. */
export interface QueryIntent extends QueryIdentity {
  claim: string
  queryId: string
  migration: string
  statementIndex: number
  phase: QueryPhase
  kind: QueryKind
  fingerprint: string
  forwardFingerprint: string
  target?: QueryTarget
  source?: QueryTarget
}

export interface QueryRecovery {
  targets: readonly QueryTarget[]
  sources?: readonly QueryTarget[]
  obligations?: readonly RecoveryObligation[]
  /** Settles a replace and returns the target under its new UUID. */
  afterCompensation(target: QueryTarget): Promise<QueryTarget>
}

export interface QueryTracker {
  command(context: QueryContext, phase: QueryPhase, sql: string, settings?: ClickHouseSettings): Promise<void>
  /** Async identities/recovery remain unchanged and are explicitly noncancellable in v1. */
  recordAsync(context: QueryContext, queryId: string): Promise<void>
}

/** CHKIT_MIGRATE_QUERY_TRACKING=off turns query tracking off for ordinary runs. */
export function queryTrackingDisabled(): boolean {
  const value = process.env.CHKIT_MIGRATE_QUERY_TRACKING?.trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false'
}

export function createQueryTracker(input: {
  db: ClickHouseExecutor
  target: LockTarget
  identity: QueryIdentity
  lock: MigrateLock
  recovery?: QueryRecovery
  log?: (line: string) => void
}): QueryTracker {
  const { db, target, identity, lock, recovery } = input
  const command = db.commandTracked?.bind(db)
  const claim = lock.claimId
  if (!command || !claim) throw cancellationError('This executor does not support tracked commands.')
  // A replace gives the target a new UUID; later intents must match it.
  let targets = recovery ? [...recovery.targets] : []
  // An ordinary run whose intent cannot be recorded continues untracked, once
  // a durable marker makes its claim uncancellable. Recovery stays strict.
  let untracked = false

  const record = async (context: QueryContext, phase: QueryPhase, sql: string, queryId: string, kind?: QueryKind, settings?: ClickHouseSettings): Promise<QueryIntent> => {
    lock.assertHeld()
    const classification = classifyQueryIntent(sql, phase, context.beforeRetry, target.database)
    const forward = classifyQueryIntent(context.forwardSQL, 'forward', context.beforeRetry, target.database)
    const matched = phase !== 'compensation' || (forward.kind === 'insert' && sameTarget(classification.target, forward.target))
    let recordedTarget = classification.target
    // Compensation retains its forward source so a crash before reload can
    // recover the same frozen input even when only a replace intent exists.
    let recordedSource = classification.source ?? (phase === 'compensation' ? forward.source : undefined)
    let verified = true
    if (kind !== 'async' && classification.kind !== 'unsupported' && identity.cluster) {
      try {
        if (recordedTarget) recordedTarget = await attestQueryTable(db, identity, recordedTarget)
        if (recordedSource) {
          recordedSource = await attestQueryTable(db, identity, recordedSource)
          if (recordedSource.uuid === recordedTarget?.uuid) throw cancellationError('A compensation target cannot also be its source.')
        }
      } catch {
        // Ordinary execution keeps its existing behavior. Unsupported coverage
        // is durable and explicit cancellation must refuse the entire claim.
        verified = false
      }
      lock.assertHeld()
    }
    const unsafeSettings = Object.entries(settings ?? {}).some(([key, value]) => value !== undefined && !CANCELLABLE_SETTINGS.has(key))
      || (settings?.async_insert !== undefined && String(settings.async_insert) !== '0')
    const intent: QueryIntent = {
      ...identity, claim, queryId, migration: context.migration, statementIndex: context.statementIndex,
      phase, fingerprint: statementFingerprint(sql), forwardFingerprint: statementFingerprint(context.forwardSQL),
      kind: kind ?? ((!verified || !matched || unsafeSettings) ? 'unsupported' : classification.kind),
      ...(recordedTarget ? { target: recordedTarget } : {}),
      ...(recordedSource ? { source: recordedSource } : {}),
    }
    if (recovery?.obligations && !recovery.obligations.some((item) => item.migration === context.migration && item.statementIndex === context.statementIndex && item.forwardFingerprint === intent.forwardFingerprint)) throw cancellationError('Explicit recovery requires the unchanged recorded forward SQL; no statement was sent.')
    if (recovery && (!['insert', 'replace'].includes(intent.kind) || !targets.some((expected) => sameTarget(expected, recordedTarget) && expected.uuid === recordedTarget?.uuid && expected.engine === recordedTarget?.engine) || (recordedSource && !recovery.sources?.some((expected) => sameTarget(expected, recordedSource) && expected.uuid === recordedSource?.uuid && expected.engine === recordedSource?.engine)))) {
      throw cancellationError('Explicit cancellation recovery requires supported SQL against the recorded table identity; no statement was sent.')
    }
    const name = `${QUERY_INTENT_PREFIX}${claim}/${queryId}`
    const checksum = JSON.stringify(intent)
    // Explicit raw dependency: storing an intent must never record another intent.
    await db.command(
      `INSERT INTO ${quoteIdentifier(target.database)}.${target.journalTable} ` +
      '(name, applied_at, checksum, chkit_version, migration_completed, operations) ' +
      `SELECT ${sqlString(name)}, now64(3), ${sqlString(checksum)}, ${sqlString(CLI_VERSION)}, false, [] SETTINGS async_insert = 0, insert_quorum = 'auto', insert_quorum_parallel = 0`,
    )
    const from = identity.cluster ? `clusterAllReplicas(${sqlString(identity.cluster)}, ${sqlString(target.database)}, ${sqlString(target.journalTable)})` : `${quoteIdentifier(target.database)}.${target.journalTable}`
    const rows = await db.query<{ checksum: string }>(
      `SELECT checksum FROM ${from} WHERE name = ${sqlString(name)} GROUP BY checksum SETTINGS skip_unavailable_shards = 0, select_sequential_consistency = 1`,
    )
    if (rows.length !== 1 || rows[0]?.checksum !== checksum) throw cancellationError('The query intent did not read back; no statement was sent.')
    lock.assertHeld()
    return intent
  }

  const markUntracked = async (error: unknown): Promise<void> => {
    if (recovery || (error instanceof MigrateError && error.code === 'migrate_lock_lost')) throw error
    try {
      await db.command(
        `INSERT INTO ${quoteIdentifier(target.database)}.${target.journalTable} ` +
        '(name, applied_at, checksum, chkit_version, migration_completed, operations) ' +
        `SELECT ${sqlString(`${QUERY_INTENT_PREFIX}${claim}/${UNTRACKED}`)}, now64(3), ${sqlString(JSON.stringify({ protocol: 1, claim }))}, ${sqlString(CLI_VERSION)}, false, [] SETTINGS async_insert = 0, insert_quorum = 'auto', insert_quorum_parallel = 0`,
      )
    } catch {
      throw error
    }
    untracked = true
    input.log?.(`⚠ Query tracking failed (${error instanceof Error ? error.message : String(error)}); this run continues untracked, and --cancel-lock-queries cannot cancel it.`)
  }

  return {
    async command(context, phase, sql, settings) {
      let physicalTarget: QueryTarget | undefined
      await command(sql, () => lock.assertHeld(), async () => {
        if (!untracked) {
          try {
            const intent = await record(context, phase, sql, randomUUID(), undefined, settings)
            physicalTarget = intent.target
            return intent.queryId
          } catch (error) {
            await markUntracked(error)
          }
        }
        return randomUUID()
      }, settings)
      lock.assertHeld()
      if (phase === 'compensation' && recovery) {
        if (!physicalTarget) throw cancellationError('Compensation has no attested target.')
        const replaced = await recovery.afterCompensation(physicalTarget)
        targets = [...targets.filter((table) => !sameTarget(table, replaced)), replaced]
        lock.assertHeld()
      }
    },
    async recordAsync(context, queryId) {
      if (untracked) return
      try {
        await record(context, 'forward', context.forwardSQL, queryId, 'async')
      } catch (error) {
        await markUntracked(error)
      }
    },
  }
}

/** Deliberately small executable-SQL whitelist, independent of operation markers. */
export function classifyQueryIntent(sql: string, phase: QueryPhase, beforeRetry: string | null, database = ''): { kind: QueryKind; target?: QueryTarget; source?: QueryTarget } {
  const tokens = tokenizeSQL(sql).filter((token) => !isTrivia(token))
  if (tokens.at(-1)?.text === ';') tokens.pop()
  if (tokens.some((token) => !token.terminated || token.text === ';')) return { kind: 'unsupported' }
  const word = (index: number) => tokens[index]?.kind === 'identifier' ? tokens[index]?.text.toUpperCase() : undefined
  if (phase === 'compensation') {
    // Exactly CREATE OR REPLACE TABLE t AS t: the same definition, empty, under
    // a new UUID, so a statement still writing to the old table stores nothing.
    if (word(0) !== 'CREATE' || word(1) !== 'OR' || word(2) !== 'REPLACE' || word(3) !== 'TABLE') return { kind: 'unsupported' }
    const parsed = readTarget(tokens, 4, database)
    if (!parsed || word(parsed.end) !== 'AS') return { kind: 'unsupported' }
    const from = readTarget(tokens, parsed.end + 1, database)
    return from && from.end === tokens.length && sameTarget(from.target, parsed.target) ? { kind: 'replace', target: parsed.target } : { kind: 'unsupported' }
  }
  if (word(0) !== 'INSERT' || word(1) !== 'INTO') return { kind: 'unsupported' }
  const parsed = readTarget(tokens, 2, database)
  if (!parsed) return { kind: 'unsupported' }
  const rest = tokens.slice(parsed.end)
  if (!hasInsertBody(rest)) return { kind: 'unsupported' }
  const unsafe = new Set(['PARALLEL', 'INSERT', 'ALTER', 'CREATE', 'DROP', 'TRUNCATE', 'INTO', 'SETTINGS'])
  if (rest.some((token) => {
    const name = identifierName(token)?.toUpperCase()
    return name !== undefined && (unsafe.has(name) || /CLUSTER$/.test(name) || /^REMOTE(SECURE)?$/.test(name))
  })) return { kind: 'unsupported' }
  if (!rest.some((token) => token.kind === 'identifier' && ['SELECT', 'VALUES'].includes(token.text.toUpperCase()))) return { kind: 'unsupported' }
  // One named source is attested before sending. Joins, nested SELECTs, views
  // and arbitrary functions cannot hide work beyond the recorded topology.
  const functions = new Set(['NUMBERS', 'NUMBERS_MT', 'SLEEP', 'SLEEPEACHROW', 'TOUINT8', 'TOUINT16', 'TOUINT32', 'TOUINT64', 'TOINT8', 'TOINT16', 'TOINT32', 'TOINT64', 'TOSTRING', 'SELECT', 'VALUES'])
  let depth = 0
  let sourceDepth: number | undefined
  let source: QueryTarget | undefined
  let selects = 0
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token?.text === '(') depth++
    if (token?.text === ')') depth--
    if (token?.text === ',' && sourceDepth !== undefined && depth <= sourceDepth) return { kind: 'unsupported' }
    const name = token && identifierName(token)?.toUpperCase()
    if (!name) continue
    if (name === 'SELECT' && ++selects > 1) return { kind: 'unsupported' }
    if (['WITH', 'JOIN', 'UNION', 'IN', 'GLOBAL'].includes(name)) return { kind: 'unsupported' }
    if (name === 'FROM') {
      if (depth !== 0 || sourceDepth !== undefined) return { kind: 'unsupported' }
      sourceDepth = depth
      const next = rest[i + 1]
      const sourceName = next && identifierName(next)?.toUpperCase()
      if (!sourceName) return { kind: 'unsupported' }
      if (!(['NUMBERS', 'NUMBERS_MT'].includes(sourceName) && rest[i + 2]?.text === '(')) {
        const parsedSource = readTarget(rest, i + 1, database || parsed.target.database)
        if (!parsedSource || rest[parsedSource.end]?.text === '(') return { kind: 'unsupported' }
        source = parsedSource.target
      }
    }
    if (rest[i + 1]?.text === '(' && !functions.has(name)) return { kind: 'unsupported' }
  }
  if (source && sameTarget(source, parsed.target)) return { kind: 'unsupported' }
  const compensation = beforeRetry === null ? undefined : classifyQueryIntent(beforeRetry, 'compensation', null, database)
  return compensation?.kind === 'replace' && sameTarget(compensation.target, parsed.target)
    ? { kind: 'insert', target: parsed.target, ...(source ? { source } : {}) }
    : { kind: 'unsupported' }
}

export function cancellationError(message: string): MigrateError {
  return new MigrateError('migrate_cancellation_failed', message)
}

export function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

export async function attestQueryTable(db: Pick<ClickHouseExecutor, 'queryControl'>, identity: QueryIdentity, target: QueryTarget): Promise<QueryTarget> {
  if (!db.queryControl || !identity.cluster) throw cancellationError('Table identity cannot be attested.')
  const rows = await db.queryControl<{ server_uuid: string; principal: string; uuid: string; engine: string; dependencies: string }>(
    `SELECT server_uuid, principal, uuid, engine, dependencies FROM clusterAllReplicas(${sqlString(identity.cluster)}, view(SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal, toString(uuid) AS uuid, engine, toJSONString(dependencies_table) AS dependencies FROM system.tables WHERE database = ${sqlString(target.database)} AND name = ${sqlString(target.name)})) SETTINGS skip_unavailable_shards = 0`, 30_000,
  )
  const first = rows[0]
  const members = rows.map((row) => row.server_uuid).sort()
  if (!first || (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(first.uuid) || first.uuid === '00000000-0000-0000-0000-000000000000') || JSON.stringify(members) !== JSON.stringify([...identity.serverUUIDs].sort()) || rows.some((row) => row.principal !== identity.principal || row.uuid !== first.uuid || row.engine !== first.engine || !['MergeTree', 'ReplicatedMergeTree', 'SharedMergeTree'].includes(row.engine) || row.dependencies !== '[]')) {
    throw cancellationError('Table identity, storage engine or replica coverage cannot be attested.')
  }
  return { ...target, uuid: first.uuid, engine: first.engine }
}

function sameTarget(left: QueryTarget | undefined, right: QueryTarget | undefined): boolean {
  return left !== undefined && right !== undefined && left.database === right.database && left.name === right.name
}

function hasInsertBody(tokens: SQLToken[]): boolean {
  let index = 0
  if (tokens[index]?.text === '(') {
    index++
    let expectName = true
    while (index < tokens.length && tokens[index]?.text !== ')') {
      const token = tokens[index]
      if (!token || (expectName ? identifierName(token) === undefined : token.text !== ',')) return false
      expectName = !expectName
      index++
    }
    if (expectName || tokens[index]?.text !== ')') return false
    index++
  }
  const token = tokens[index]
  return token?.kind === 'identifier' && ['SELECT', 'VALUES'].includes(token.text.toUpperCase())
}

function readTarget(tokens: SQLToken[], start: number, database: string): { target: QueryTarget; end: number } | undefined {
  const firstToken = tokens[start]
  const first = firstToken && identifierName(firstToken)
  if (!first) return undefined
  if (tokens[start + 1]?.text === '.') {
    const nameToken = tokens[start + 2]
    const name = nameToken && identifierName(nameToken)
    return name ? { target: { database: first, name }, end: start + 3 } : undefined
  }
  return database ? { target: { database, name: first }, end: start + 1 } : undefined
}
