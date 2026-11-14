import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ClickHouseExecutor, ClickHouseSettings, QueryControlOptions } from '@chkit/clickhouse'
import { compareCodePoints, quoteIdentifier, statementFingerprint } from '@chkit/core'

import { debug } from '../../runtime/debug.js'
import { CLI_VERSION } from '../../runtime/version.js'
import { MigrateError } from './errors.js'
import { claimsSelectSql, LOCK_ROW_PREFIX, type LockTarget, type MigrateLock } from './lock.js'
import { attestQueryTable, classifyQueryIntent, cancellationError, QUERY_INTENT_PREFIX, sqlString, UNTRACKED, type QueryContext, type QueryIdentity, type QueryIntent, type QueryTarget } from './query-intents.js'

export const RECOVERY_PREFIX = '__chkit_migrate_recovery__/'
export const CANCELLATION_PREFIX = '__chkit_migrate_cancel__/'
/** `<prefix><old uuid>`: a recovery replaced that table; the row names its new UUID. */
export const REPLACE_PREFIX = '__chkit_migrate_replace__/'
const DEADLINE_MS = 30_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Topology { identity: QueryIdentity }
interface Control { query<T>(sql: string, options?: QueryControlOptions): Promise<T[]>; remaining(): number }
export interface RecoveryObligation { migration: string; statementIndex: number; forwardFingerprint: string; target: QueryTarget; source?: QueryTarget }
export interface RecoveryContext { protocol: 1; claim: string; identity: QueryIdentity; parents: string[]; obligations: RecoveryObligation[] }
interface RecoveryRecord { context: RecoveryContext; checksum: string; completed: boolean }
/**
 * How recorded target UUIDs map to live tables: durable replace markers, the
 * targets of recorded replaces whose marker may be missing (a crash right after
 * the replace), and replacements this run adopted for those.
 */
interface Resolution { replaced: Map<string, string>; pending: Set<string>; adopted: Map<string, QueryTarget> }
export interface CancellationPlan { claim: string; holder: string; identity: QueryIdentity; resumePending: boolean; targets: QueryTarget[]; sources: QueryTarget[]; parents: string[]; obligations: RecoveryObligation[]; inherited: boolean }

/** Explicit recovery must make every decision from fresh, complete reads. */
export function freshRecoveryExecutor(db: ClickHouseExecutor): ClickHouseExecutor {
  const query = db.queryControl?.bind(db)
  if (!query) throw cancellationError('Explicit recovery requires bounded fresh control reads.')
  return new Proxy(db, {
    get(target, property) {
      if (property === 'queryStatus') return async () => { throw cancellationError('Explicit recovery cannot attach historical async queries. Finish async recovery before using --cancel-lock-queries.') }
      if (property === 'query') return <T>(sql: string, settings?: ClickHouseSettings) => query<T>(sql, DEADLINE_MS, { settings: { ...settings, skip_unavailable_shards: 0 } })
      if (property === 'openConcurrent') {
        const open = target.openConcurrent?.bind(target)
        return open ? () => freshRecoveryExecutor(open()) : undefined
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Missing/denied discovery never supplies a single-server fallback. */
export async function resolveQueryIdentity(db: ClickHouseExecutor, configuredCluster?: string): Promise<QueryIdentity> {
  const cluster = configuredCluster ?? db.queryControlCluster
  if (!cluster) throw cancellationError('Cancellation requires a declared ClickHouse cluster (clickhouse.cluster or the console transport cluster).')
  return (await topology(control(db), cluster)).identity
}

/** Preflight is read-only and validates every retained intent before takeover. */
export async function prepareCancellation(db: ClickHouseExecutor, target: LockTarget, identity: QueryIdentity, requestedClaim: string): Promise<CancellationPlan> {
  const claim = requestedClaim.replace(new RegExp(`^${LOCK_ROW_PREFIX}`), '')
  if (!UUID.test(claim)) throw cancellationError('Cancellation requires an exact recorded claim UUID.')
  const conn = control(db)
  await assertIdentityTopology(conn, identity)
  const history = await recoveryHistory(conn, target, identity)
  assertNoSuccessor(history, claim)
  const inherited = history.get(claim)
  if (inherited?.completed) throw cancellationError('This recovery completed; name the actual newer stopped claim.')
  if (inherited && !sameIdentity(inherited.context.identity, identity)) throw cancellationError('Recovery belongs to another SQL identity or topology.')
  const rows = await conn.query<{ name: string; holder: string }>(claimsSelectSql({ ...target, fanout: { cluster: requireCluster(identity), replicas: identity.serverUUIDs.length } }, `${LOCK_ROW_PREFIX}${claim}`))
  const predecessor = rows.find((row) => row.name === `${LOCK_ROW_PREFIX}${claim}`)
  if (!predecessor) throw cancellationError('The named predecessor claim is missing; no query was canceled.')
  const holder = objectJSON(predecessor.holder)
  const recorded = parseIdentity(holder.queries)
  if (!sameIdentity(recorded, identity)) throw cancellationError('The predecessor is untracked, uses another SQL principal, or belongs to another topology.')
  const resolution = await readResolution(conn, target, identity)
  const intents = await validateIntents(conn, target, identity, claim, inherited !== undefined, resolution)
  const obligations = uniqueObligations(await validateObligations(conn, identity, [...(inherited?.context.obligations ?? []), ...obligationsFromIntents(intents)], target, resolution))
  assertIntentsCovered(intents, obligations)
  await assertReplaceGrants(conn, obligations)
  const markers = await variants(conn, source(target, identity), `startsWith(name, ${sqlString(`${CANCELLATION_PREFIX}${claim}/`)})`)
  if (markers.some((row) => row.name.endsWith('/completed'))) throw cancellationError('This predecessor cancellation already completed. Name the actual newer stopped claim instead, or run ordinary apply.')
  return { claim, holder: predecessor.holder, identity, targets: obligations.map((item) => item.target), sources: obligations.flatMap((item) => item.source ? [item.source] : []), parents: inherited?.context.parents ?? [], obligations, inherited: inherited !== undefined, resumePending: inherited !== undefined || markers.some((row) => row.name.endsWith('/pending')) }
}

/** Attest the complete selected recovery plan before any claim is broken or query killed. */
export async function expandRecoveryPlan(db: ClickHouseExecutor, target: LockTarget, plan: CancellationPlan, contexts: readonly QueryContext[]): Promise<CancellationPlan> {
  const conn = control(db)
  const additions: RecoveryObligation[] = []
  for (const context of contexts) {
    const classified = classifyQueryIntent(context.forwardSQL, 'forward', context.beforeRetry, target.database)
    if (classified.kind !== 'insert' || !classified.target) throw cancellationError(`Recovery requires supported synchronous INSERT/replace pairs throughout ${context.migration}; no query was canceled.`)
    const metadata = { queryControl: <T>(sql: string) => conn.query<T>(sql) }
    const table = await attestQueryTable(metadata, plan.identity, classified.target)
    const sourceTable = classified.source ? await attestQueryTable(metadata, plan.identity, classified.source) : undefined
    const obligation = { migration: context.migration, statementIndex: context.statementIndex, forwardFingerprint: statementFingerprint(context.forwardSQL), target: table, ...(sourceTable ? { source: sourceTable } : {}) }
    additions.push(...await validateObligations(conn, plan.identity, [obligation], target, emptyResolution()))
  }
  for (const inherited of plan.obligations) {
    if (!additions.some((item) => item.migration === inherited.migration && item.statementIndex === inherited.statementIndex)) await assertJournalCoverage(conn, target, plan.identity, [inherited])
  }
  const obligations = uniqueObligations([...plan.obligations, ...additions])
  await assertReplaceGrants(conn, obligations)
  return { ...plan, obligations, targets: obligations.map((item) => item.target), sources: obligations.flatMap((item) => item.source ? [item.source] : []) }
}

/** Called under the new reservation before reclaiming a crashed successor. */
export async function assertCancellationUnfinished(db: ClickHouseExecutor, target: LockTarget, plan: CancellationPlan, reservations: readonly { claim: string; holder: string }[] = []): Promise<void> {
  const conn = control(db)
  const history = await recoveryHistory(conn, target, plan.identity)
  assertNoSuccessor(history, plan.claim)
  const rows = await variants(conn, source(target, plan.identity), `startsWith(name, ${sqlString(`${CANCELLATION_PREFIX}${plan.claim}/`)})`)
  if (rows.some((row) => row.name.endsWith('/completed'))) throw cancellationError('Cancellation completed; another owner may have admitted its own queries.')
  if (rows.some((row) => row.name.endsWith('/pending'))) return
  const inherited = history.get(plan.claim)
  if (inherited?.completed || reservations.length === 0) throw cancellationError('Cancellation is not durably unfinished; another owner may have admitted its own queries.')
  for (const reservation of reservations) {
    const holder = objectJSON(reservation.holder)
    if (holder.recoveryOf !== plan.claim || !sameIdentity(parseIdentity(holder.queries), plan.identity) || history.has(reservation.claim)) throw cancellationError('A competing claim is not a linked reservation-only recovery.')
    if ((await validateIntents(conn, target, plan.identity, reservation.claim, true, await readResolution(conn, target, plan.identity))).length !== 0) throw cancellationError('A competing recovery already recorded migration work; name its actual claim.')
  }
}

/** This stable marker is acknowledged while the replacement reservation exists. */
export async function markCancellationPending(db: ClickHouseExecutor, target: LockTarget, plan: CancellationPlan): Promise<void> {
  await writeMarker(db, target, plan, 'pending')
}

/** All later owners, including no-pending runs, must honor interrupted cancellation. */
export async function assertCancellationClear(db: ClickHouseExecutor, target: LockTarget, allowedClaim?: string, identity?: QueryIdentity): Promise<void> {
  const conn = controlOrQuery(db)
  const coverage = identity ?? (db.queryControlCluster ? { protocol: 1 as const, principal: '', serverUUIDs: [], cluster: db.queryControlCluster } : undefined)
  const history = await recoveryHistory(conn, target, coverage)
  const allowed = allowedClaim ? history.get(allowedClaim) : undefined
  const ancestors = allowed && !allowed.completed ? allowed.context.parents : []
  for (const [claim, record] of history) {
    if (!record.completed && claim !== allowedClaim && !ancestors.includes(claim)) {
      const successor = newestRequired(history, claim)
      throw cancellationError(`Recovery of claim ${successor} is unfinished. Stop that CLI, then resume with --apply --break-lock ${successor} --cancel-lock-queries.`)
    }
  }
  const rows = await variants(conn, source(target, coverage), `startsWith(name, ${sqlString(CANCELLATION_PREFIX)})`)
  const markers = new Map<string, string>()
  for (const row of rows) {
    const suffix = row.name.slice(CANCELLATION_PREFIX.length)
    const [claim, phase, ...rest] = suffix.split('/')
    if (!claim || !UUID.test(claim) || !['pending', 'completed'].includes(phase ?? '') || rest.length) throw cancellationError('Malformed cancellation history; refusing migration work.')
    const data = objectJSON(row.checksum)
    if (data.protocol !== 1 || data.claim !== claim) throw cancellationError('Malformed cancellation marker; refusing migration work.')
    parseIdentity(data.identity)
    markers.set(suffix, row.checksum)
  }
  for (const [name, checksum] of markers) {
    if (!name.endsWith('/pending')) continue
    const claim = name.slice(0, -'/pending'.length)
    const completed = markers.get(`${claim}/completed`)
    if (completed !== undefined && completed !== checksum) throw cancellationError('Conflicting cancellation completion history; refusing migration work.')
    if (completed === undefined && claim !== allowedClaim && !ancestors.includes(claim)) throw cancellationError(`Cancellation of claim ${claim} is unfinished. Stop its old CLI, then resume with --apply --break-lock ${claim} --cancel-lock-queries.`)
  }
}

/**
 * No compensation or replacement statement may run until this returns. The
 * KILL only frees the server: the replace of each target is what keeps a
 * stopped statement from storing rows (#732).
 */
export async function cancelPredecessor(db: ClickHouseExecutor, target: LockTarget, plan: CancellationPlan, lock: MigrateLock): Promise<RecoveryContext> {
  const conn = control(db, lock)
  const { identity, claim } = plan
  await assertIdentityTopology(conn, identity)
  // A fresh read closes the validation-to-reservation interval. Validate the
  // entire set before the first KILL, so unsupported work is never guessed at.
  const history = await recoveryHistory(conn, target, identity)
  assertNoSuccessor(history, claim)
  if (plan.inherited && !history.get(claim)) throw cancellationError('The inherited recovery context disappeared.')
  const resolution = await readResolution(conn, target, identity)
  const intents = await validateIntents(conn, target, identity, claim, plan.inherited, resolution)
  const obligations = uniqueObligations(await validateObligations(conn, identity, plan.obligations, target, resolution))
  assertIntentsCovered(intents, obligations)
  const ids = intents.map((intent) => intent.queryId)
  if (ids.length > 0) {
    const processes = await conn.query<{ query_id: string; initial_query_id: string; user: string; initial_user: string }>(
      `SELECT query_id, initial_query_id, user, initial_user FROM clusterAllReplicas(${sqlString(requireCluster(identity))}, system.processes) WHERE query_id IN (${ids.map(sqlString).join(',')}) OR initial_query_id IN (${ids.map(sqlString).join(',')}) SETTINGS skip_unavailable_shards = 0`,
    )
    for (const row of processes) {
      if ((ids.includes(row.query_id) && row.user !== identity.principal) || (ids.includes(row.initial_query_id) && row.initial_user !== identity.principal)) {
        throw cancellationError('A recorded query id belongs to another SQL principal; no query was canceled.')
      }
    }
    await killRecordedQueries(conn, identity, ids)
  }
  // A recorded replace whose marker the stopped run never wrote: record the
  // UUID it left, so every later read resolves the same table.
  for (const [from, table] of resolution.adopted) await writeReplaceMarker(conn, target, identity, from, table)
  lock.assertHeld()
  const activeClaim = lock.claimId
  if (!activeClaim || !UUID.test(activeClaim)) throw cancellationError('The replacement lock has no valid claim identity.')
  const context: RecoveryContext = { protocol: 1, claim: activeClaim, identity, parents: [...new Set([claim, ...plan.parents])].sort(), obligations }
  // This barrier is durable BEFORE old completion and BEFORE even the first
  // replacement intent/user send.
  await writeRecoveryMarker(conn, target, context, 'required')
  for (const ancestor of context.parents) {
    const cancellationRows = await variants(conn, source(target, identity), `name = ${sqlString(`${CANCELLATION_PREFIX}${ancestor}/pending`)}`)
    if (ancestor === claim || cancellationRows.length > 0) await writeMarker(db, target, { ...plan, claim: ancestor }, 'completed', conn)
    const previous = history.get(ancestor)
    if (previous && !previous.completed) await writeRecoveryMarker(conn, target, previous.context, 'completed')
  }
  lock.assertHeld()
  return context
}

/** Only durable complete journal coverage can release the last recovery barrier. */
export async function finishRecovery(db: ClickHouseExecutor, target: LockTarget, context: RecoveryContext, lock: MigrateLock): Promise<void> {
  const conn = control(db, lock)
  await assertIdentityTopology(conn, context.identity)
  const resolution = await readResolution(conn, target, context.identity)
  const ownIntents = await validateIntents(conn, target, context.identity, context.claim, true, resolution)
  const obligations = uniqueObligations(await validateObligations(conn, context.identity, [...context.obligations, ...obligationsFromIntents(ownIntents)], target, resolution))
  await assertJournalCoverage(conn, target, context.identity, obligations)
  await writeRecoveryMarker(conn, target, context, 'completed')
}

async function assertJournalCoverage(conn: Control, target: LockTarget, identity: QueryIdentity, obligations: readonly RecoveryObligation[]): Promise<void> {
  const names = [...new Set(obligations.map((item) => item.migration))]
  const rows = await conn.query<{ name: string; migration_completed: string; operations: string }>(
    `SELECT name, toString(toUInt8(latest.1)) AS migration_completed, toJSONString(arrayMap((op, fp) -> tuple(op.operation_index, op.status, fp), latest.2, latest.3)) AS operations FROM (SELECT name, argMax(tuple(migration_completed, operations, operation_fingerprints), applied_at) AS latest FROM ${source(target, identity)} WHERE name IN (${names.map(sqlString).join(',')}) GROUP BY name) SETTINGS skip_unavailable_shards = 0, select_sequential_consistency = 1`,
  )
  for (const obligation of obligations) {
    const row = rows.find((item) => item.name === obligation.migration)
    const operations: unknown = row ? JSON.parse(row.operations) : undefined
    if (!row || row.migration_completed !== '1' || !Array.isArray(operations) || !operations.some((op: unknown) => Array.isArray(op) && op[0] === obligation.statementIndex && op[1] === 'completed' && op[2] === obligation.forwardFingerprint)) {
      throw cancellationError(`Recovery still requires ${obligation.migration} statement ${obligation.statementIndex + 1}. Restore its unchanged SQL and include it in apply; the recovery barrier remains.`)
    }
  }
}

/**
 * After the replace of `table`: wait until every replica serves the new, empty
 * table, then durably record its new UUID before any reload (#732).
 */
export async function settleCompensation(db: ClickHouseExecutor, target: LockTarget, plan: CancellationPlan, table: QueryTarget, lock: MigrateLock): Promise<QueryTarget> {
  const conn = control(db, lock)
  await assertIdentityTopology(conn, plan.identity)
  if (!table.uuid) throw cancellationError('Compensation has no recorded table identity.')
  let replaced: QueryTarget | undefined
  while (!replaced) {
    const rows = await tableRows(conn, plan.identity, table)
    const uuid = rows[0]?.uuid
    if (sameMembers(rows, plan.identity) && uuid && uuid !== table.uuid && rows.every((row) => row.uuid === uuid)) {
      if (rows.some((row) => row.principal !== plan.identity.principal || row.engine !== table.engine || row.dependencies !== '[]')) throw cancellationError('The replaced table changed engine or gained dependencies; reload is blocked.')
      replaced = { database: table.database, name: table.name, uuid, engine: table.engine }
    } else await sleep(Math.min(100, conn.remaining()))
  }
  await writeReplaceMarker(conn, target, plan.identity, table.uuid, replaced)
  lock.assertHeld()
  return replaced
}

async function writeReplaceMarker(conn: Control, target: LockTarget, identity: QueryIdentity, from: string, table: QueryTarget): Promise<void> {
  const name = `${REPLACE_PREFIX}${from}`
  const checksum = JSON.stringify({ protocol: 1, from, ...table })
  await conn.query(`INSERT INTO ${quoteIdentifier(target.database)}.${target.journalTable} (name, applied_at, checksum, chkit_version, migration_completed, operations) SELECT ${sqlString(name)}, now64(3), ${sqlString(checksum)}, ${sqlString(CLI_VERSION)}, false, [] SETTINGS async_insert = 0, insert_quorum = 'auto', insert_quorum_parallel = 0`)
  const rows = await variants(conn, source(target, identity), `name = ${sqlString(name)}`)
  if (rows.length !== 1 || rows[0]?.checksum !== checksum) throw cancellationError('The replace marker did not read back; reload is blocked.')
}

async function readResolution(conn: Control, target: LockTarget, identity: QueryIdentity): Promise<Resolution> {
  const resolution = emptyResolution()
  for (const row of await variants(conn, source(target, identity), `startsWith(name, ${sqlString(REPLACE_PREFIX)})`)) {
    const from = row.name.slice(REPLACE_PREFIX.length)
    const data = objectJSON(row.checksum)
    const to = recordedTable(data)
    if (!UUID.test(from) || data.protocol !== 1 || data.from !== from || to.uuid === from) throw cancellationError('Malformed replace history.')
    resolution.replaced.set(from, to.uuid ?? '')
  }
  return resolution
}

function emptyResolution(): Resolution {
  return { replaced: new Map(), pending: new Set(), adopted: new Map() }
}

/** The UUID a recorded one resolves to through durable replace markers. */
function resolveUUID(resolution: Resolution, uuid: string): string {
  const seen = new Set<string>()
  let current = uuid
  for (let next = resolution.replaced.get(current); next !== undefined; next = resolution.replaced.get(current)) {
    if (seen.has(current)) throw cancellationError('Cyclic replace history.')
    seen.add(current)
    current = next
  }
  return current
}

/** Local KILLs, one per declared member, so a round-robin endpoint reaches each. Best effort. */
async function killRecordedQueries(conn: Control, identity: QueryIdentity, ids: string[]): Promise<void> {
  for (let attempt = 0; attempt < identity.serverUUIDs.length; attempt++) {
    try {
      await conn.query(`KILL QUERY WHERE ${processPredicate(identity, ids)} ASYNC`)
    } catch (error) {
      if (error instanceof MigrateError) throw error
      debug('migrate:queries', `KILL failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** The replace needs CREATE TABLE and DROP TABLE on each target, granted directly or through enabled roles. */
async function assertReplaceGrants(conn: Control, obligations: readonly RecoveryObligation[]): Promise<void> {
  const rows = await conn.query<{ access_type: string; database: string | null; table: string | null; is_partial_revoke: unknown }>(
    "SELECT access_type, database, table, is_partial_revoke FROM system.grants WHERE (user_name = currentUser() OR role_name IN (SELECT role_name FROM system.enabled_roles)) AND access_type IN ('ALL', 'CREATE', 'CREATE TABLE', 'DROP', 'DROP TABLE') AND column IS NULL",
  )
  const covers = (row: (typeof rows)[number], table: QueryTarget) => (row.database === null || row.database === table.database) && (row.table === null || row.table === table.name)
  const allowed = (access: string[], table: QueryTarget) =>
    rows.some((row) => access.includes(row.access_type) && !isTrue(row.is_partial_revoke) && covers(row, table)) &&
    !rows.some((row) => access.includes(row.access_type) && isTrue(row.is_partial_revoke) && covers(row, table))
  for (const { target } of obligations) {
    if (!allowed(['ALL', 'CREATE', 'CREATE TABLE'], target) || !allowed(['ALL', 'DROP', 'DROP TABLE'], target)) {
      throw cancellationError(`Recovery replaces ${target.database}.${target.name}, which needs CREATE TABLE and DROP TABLE on it.`)
    }
  }
}

function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function control(db: ClickHouseExecutor, lock?: MigrateLock): Control {
  const query = db.queryControl?.bind(db)
  if (!query || !db.commandTracked) throw cancellationError('This executor cannot safely track and cancel physical queries.')
  const deadline = performance.now() + DEADLINE_MS
  const remaining = () => {
    lock?.assertHeld()
    const ms = deadline - performance.now()
    if (ms <= 0) throw cancellationError('Cancellation deadline expired; replacement work is blocked.')
    return ms
  }
  return { remaining, async query<T>(sql: string, options?: QueryControlOptions) { const rows = await query<T>(sql, remaining(), options); remaining(); return rows } }
}

function controlOrQuery(db: ClickHouseExecutor): Control {
  return db.queryControl && db.commandTracked ? control(db) : { query: (sql) => db.query(sql), remaining: () => DEADLINE_MS }
}

async function topology(conn: Control, cluster: string): Promise<Topology> {
  const nodesSQL = `SELECT server_uuid, principal FROM clusterAllReplicas(${sqlString(cluster)}, view(SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal FROM system.one)) SETTINGS skip_unavailable_shards = 0`
  const localSQL = 'SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal'
  const nodes = await conn.query<{ server_uuid: string; principal: string }>(nodesSQL)
  const local = await conn.query<{ server_uuid: string; principal: string }>(localSQL)
  const confirmed = await conn.query<{ server_uuid: string; principal: string }>(nodesSQL)
  const localAfter = await conn.query<{ server_uuid: string; principal: string }>(localSQL)
  const nodeKey = (rows: typeof nodes) => rows.map((row) => `${row.server_uuid}/${row.principal}`).sort()
  const uuids = nodes.map((row) => row.server_uuid).sort()
  const principal = nodes[0]?.principal
  if (!principal || nodes.length === 0 || new Set(uuids).size !== nodes.length || uuids.some((uuid) => !UUID.test(uuid)) || nodes.some((row) => row.principal !== principal) || JSON.stringify(nodeKey(nodes)) !== JSON.stringify(nodeKey(confirmed)) || [local, localAfter].some((rows) => rows.length !== 1 || rows[0]?.principal !== principal || !uuids.includes(rows[0]?.server_uuid ?? ''))) {
    throw cancellationError('Cancellation cannot establish stable, complete same-principal replica coverage.')
  }
  return { identity: { protocol: 1, principal, serverUUIDs: uuids, cluster } }
}

async function assertIdentityTopology(conn: Control, identity: QueryIdentity): Promise<Topology> {
  const current = await topology(conn, requireCluster(identity))
  if (!sameIdentity(current.identity, identity)) throw cancellationError('The SQL principal or server topology changed; replacement work is blocked.')
  return current
}

async function validateIntents(conn: Control, target: LockTarget, identity: QueryIdentity, claim: string, allowEmpty: boolean, resolution: Resolution): Promise<QueryIntent[]> {
  const prefix = `${QUERY_INTENT_PREFIX}${claim}/`
  const rows = await variants(conn, source(target, identity), `startsWith(name, ${sqlString(prefix)})`)
  if (rows.length === 0 && !allowEmpty) throw cancellationError('The predecessor has no cancellable tracked queries.')
  if (rows.some((row) => row.name === `${prefix}${UNTRACKED}`)) throw cancellationError('The predecessor ran statements chkit could not track, so it cannot be cancelled. Stop it and recover by hand.')
  const parsed = rows.map((row) => ({ queryId: row.name.slice(prefix.length), data: objectJSON(row.checksum) }))
  // A recorded replace may have run without its marker: its target can have a new UUID.
  for (const { data } of parsed) {
    if (data.phase === 'compensation' && isObject(data.target) && typeof data.target.uuid === 'string') resolution.pending.add(resolveUUID(resolution, data.target.uuid))
  }
  const intents: QueryIntent[] = []
  for (const { queryId, data } of parsed) {
    const recordedIdentity = parseIdentity(data)
    if (!UUID.test(queryId) || data.queryId !== queryId || data.claim !== claim || !sameIdentity(recordedIdentity, identity) || !['forward', 'compensation'].includes(String(data.phase)) || data.kind !== (data.phase === 'forward' ? 'insert' : 'replace') || typeof data.migration !== 'string' || !Number.isInteger(data.statementIndex) || Number(data.statementIndex) < 0 || typeof data.fingerprint !== 'string' || !/^v1:[0-9a-f]{64}$/.test(data.fingerprint) || typeof data.forwardFingerprint !== 'string' || !/^v1:[0-9a-f]{64}$/.test(data.forwardFingerprint) || (data.phase === 'forward' && data.fingerprint !== data.forwardFingerprint)) {
      throw cancellationError('The predecessor contains unsupported, async or malformed query intents; no query was canceled.')
    }
    assertNotJournal(target, recordedTable(data.target))
    if (data.source !== undefined) assertNotJournal(target, recordedTable(data.source))
    const table = await validateTable(conn, identity, data.target, false, resolution)
    const sourceTable = data.source === undefined ? undefined : await validateTable(conn, identity, data.source, true, resolution)
    if (sourceTable && sourceTable.uuid === table.uuid) throw cancellationError('The compensation would replace its own source; replacement work is blocked.')
    intents.push({ ...recordedIdentity, claim, queryId, migration: data.migration, statementIndex: Number(data.statementIndex), phase: data.phase === 'forward' ? 'forward' : 'compensation', kind: data.phase === 'forward' ? 'insert' : 'replace', fingerprint: data.fingerprint, forwardFingerprint: data.forwardFingerprint, target: table, ...(sourceTable ? { source: sourceTable } : {}) })
  }
  return intents
}

type TableRow = { server_uuid: string; principal: string; uuid: string; engine: string; dependencies: string; database_engine: string }

async function tableRows(conn: Control, identity: QueryIdentity, table: { database: string; name: string }): Promise<TableRow[]> {
  return await conn.query<TableRow>(
    `SELECT server_uuid, principal, uuid, engine, dependencies, database_engine FROM clusterAllReplicas(${sqlString(requireCluster(identity))}, view(SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal, toString(uuid) AS uuid, engine, toJSONString(dependencies_table) AS dependencies, (SELECT any(engine) FROM system.databases WHERE name = ${sqlString(table.database)}) AS database_engine FROM system.tables WHERE database = ${sqlString(table.database)} AND name = ${sqlString(table.name)})) SETTINGS skip_unavailable_shards = 0`,
  )
}

function sameMembers(rows: readonly { server_uuid: string }[], identity: QueryIdentity): boolean {
  return JSON.stringify(rows.map((row) => row.server_uuid).sort()) === JSON.stringify([...identity.serverUUIDs].sort())
}

/** The live table a recorded one stands for now, refusing any change recovery did not make. */
async function validateTable(conn: Control, identity: QueryIdentity, value: unknown, sourceTable: boolean, resolution: Resolution): Promise<QueryTarget> {
  if (!isObject(value) || typeof value.database !== 'string' || typeof value.name !== 'string' || !value.database || !value.name) throw cancellationError('A query intent has no valid SQL table.')
  if (typeof value.uuid !== 'string' || !UUID.test(value.uuid) || value.uuid === '00000000-0000-0000-0000-000000000000' || typeof value.engine !== 'string') throw cancellationError('A table source or target has no recorded storage identity.')
  const metadata = await tableRows(conn, identity, { database: value.database, name: value.name })
  const engines = sourceTable ? ['MergeTree', 'ReplicatedMergeTree', 'SharedMergeTree'] : ['MergeTree', 'SharedMergeTree']
  if (metadata.length !== identity.serverUUIDs.length || metadata.some((row) => !engines.includes(row.engine) || row.dependencies !== '[]') || (!sourceTable && value.engine === 'MergeTree' && identity.serverUUIDs.length !== 1)) throw cancellationError('Cancellation requires a plain MergeTree target on one declared server, or a SharedMergeTree target, without materialized-view dependencies.')
  if (!sourceTable && metadata.some((row) => !['Atomic', 'Shared'].includes(row.database_engine))) throw cancellationError('Recovery replaces its targets, which needs an Atomic or Shared database.')
  const expected = sourceTable ? value.uuid : resolveUUID(resolution, value.uuid)
  const live = metadata[0]?.uuid ?? ''
  const adopted = !sourceTable && live !== expected && resolution.pending.has(expected) && UUID.test(live)
  if (!sameMembers(metadata, identity) || metadata.some((row) => row.principal !== identity.principal || row.uuid !== (adopted ? live : expected) || row.engine !== value.engine)) throw cancellationError('A recorded source or target identity changed; replacement work is blocked.')
  const table = { database: value.database, name: value.name, uuid: adopted ? live : expected, engine: value.engine }
  if (adopted) resolution.adopted.set(expected, table)
  return table
}

async function recoveryHistory(conn: Control, target: LockTarget, identity?: QueryIdentity): Promise<Map<string, RecoveryRecord>> {
  const rows = await variants(conn, source(target, identity), `startsWith(name, ${sqlString(RECOVERY_PREFIX)})`)
  const required = new Map<string, RecoveryRecord>()
  const completed = new Map<string, string>()
  for (const row of rows) {
    const [claim, phase, ...rest] = row.name.slice(RECOVERY_PREFIX.length).split('/')
    if (!claim || !UUID.test(claim) || !['required', 'completed'].includes(phase ?? '') || rest.length) throw cancellationError('Malformed recovery history.')
    const context = parseRecoveryContext(objectJSON(row.checksum))
    if (context.claim !== claim) throw cancellationError('Conflicting recovery claim identity.')
    if (phase === 'required') required.set(claim, { context, checksum: row.checksum, completed: false })
    else completed.set(claim, row.checksum)
  }
  for (const [claim, checksum] of completed) {
    const record = required.get(claim)
    if (!record || record.checksum !== checksum) throw cancellationError('Conflicting recovery completion history.')
    record.completed = true
  }
  for (const record of required.values()) for (const parent of record.context.parents) {
    const ancestor = required.get(parent)
    if (ancestor && (!sameIdentity(ancestor.context.identity, record.context.identity) || ancestor.context.parents.includes(record.context.claim))) throw cancellationError('Conflicting or cyclic recovery ancestry.')
  }
  return required
}

function parseRecoveryContext(data: Record<string, unknown>): RecoveryContext {
  if (data.protocol !== 1 || typeof data.claim !== 'string' || !UUID.test(data.claim) || !Array.isArray(data.parents) || data.parents.length === 0 || data.parents.some((parent: unknown) => typeof parent !== 'string' || !UUID.test(parent) || parent === data.claim) || JSON.stringify(data.parents) !== JSON.stringify([...new Set(data.parents)].sort()) || !Array.isArray(data.obligations) || data.obligations.length === 0) throw cancellationError('Malformed inherited recovery context.')
  const identity = parseIdentity(data.identity)
  const obligations = data.obligations.map((value: unknown) => {
    if (!isObject(value) || typeof value.migration !== 'string' || !value.migration || !Number.isInteger(value.statementIndex) || Number(value.statementIndex) < 0 || typeof value.forwardFingerprint !== 'string' || !/^v1:[0-9a-f]{64}$/.test(value.forwardFingerprint)) throw cancellationError('Malformed recovery obligation.')
    const target = recordedTable(value.target)
    const sourceTable = value.source === undefined ? undefined : recordedTable(value.source)
    return { migration: value.migration, statementIndex: Number(value.statementIndex), forwardFingerprint: value.forwardFingerprint, target, ...(sourceTable ? { source: sourceTable } : {}) }
  })
  return { protocol: 1, claim: data.claim, identity, parents: data.parents.map(String), obligations: uniqueObligations(obligations) }
}

function recordedTable(value: unknown): QueryTarget {
  if (!isObject(value) || typeof value.database !== 'string' || !value.database || typeof value.name !== 'string' || !value.name || typeof value.uuid !== 'string' || !UUID.test(value.uuid) || value.uuid === '00000000-0000-0000-0000-000000000000' || typeof value.engine !== 'string') throw cancellationError('Malformed recovery table identity.')
  return { database: value.database, name: value.name, uuid: value.uuid, engine: value.engine }
}

function obligationsFromIntents(intents: QueryIntent[]): RecoveryObligation[] {
  return uniqueObligations(intents.map((intent) => ({ migration: intent.migration, statementIndex: intent.statementIndex, forwardFingerprint: intent.forwardFingerprint, target: recordedTable(intent.target), ...(intent.source ? { source: recordedTable(intent.source) } : {}) })))
}

function uniqueObligations(obligations: RecoveryObligation[]): RecoveryObligation[] {
  const result = new Map<string, RecoveryObligation>()
  for (const obligation of obligations) {
    const key = JSON.stringify([obligation.migration, obligation.statementIndex])
    const previous = result.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(obligation)) throw cancellationError('Conflicting recovery obligations for a statement.')
    result.set(key, obligation)
  }
  const values = [...result.values()]
  const targets = new Set<string>()
  for (const item of values) {
    if (!item.target.uuid || targets.has(item.target.uuid)) throw cancellationError('Recovery requires a distinct compensation target for each statement.')
    targets.add(item.target.uuid)
  }
  if (values.some((item) => item.source?.uuid && targets.has(item.source.uuid))) throw cancellationError("A recovery compensation would mutate another statement's frozen source.")
  return values.sort((a, b) => compareCodePoints(a.migration, b.migration) || a.statementIndex - b.statementIndex)
}

function assertIntentsCovered(intents: QueryIntent[], obligations: RecoveryObligation[]): void {
  for (const intent of intents) if (!obligations.some((item) => JSON.stringify(item) === JSON.stringify(obligationsFromIntents([intent])[0]))) throw cancellationError('A successor admitted work outside its inherited recovery context.')
}

/** Each obligation with its tables resolved to the live ones. */
async function validateObligations(conn: Control, identity: QueryIdentity, obligations: RecoveryObligation[], journal: LockTarget, resolution: Resolution): Promise<RecoveryObligation[]> {
  if (obligations.length === 0) throw cancellationError('Recovery has no complete forward obligations.')
  const validated: RecoveryObligation[] = []
  for (const item of obligations) {
    assertNotJournal(journal, item.target)
    if (item.source) assertNotJournal(journal, item.source)
    const target = await validateTable(conn, identity, item.target, false, resolution)
    const sourceTable = item.source ? await validateTable(conn, identity, item.source, true, resolution) : undefined
    validated.push({ migration: item.migration, statementIndex: item.statementIndex, forwardFingerprint: item.forwardFingerprint, target, ...(sourceTable ? { source: sourceTable } : {}) })
  }
  return validated
}

function assertNotJournal(journal: LockTarget, table: QueryTarget): void {
  if (table.database === journal.database && table.name === journal.journalTable) throw cancellationError('The migration journal cannot be a recovery target or source.')
}

function newestRequired(history: Map<string, RecoveryRecord>, claim: string): string {
  const descendants = [...history.values()].filter((record) => !record.completed && record.context.parents.includes(claim))
  const leaves = descendants.filter((record) => !descendants.some((other) => other.context.parents.includes(record.context.claim)))
  if (leaves.length > 1) throw cancellationError('Several unresolved successor recoveries exist; migration work is blocked.')
  return leaves[0]?.context.claim ?? claim
}

function assertNoSuccessor(history: Map<string, RecoveryRecord>, claim: string): void {
  const newest = newestRequired(history, claim)
  if (newest !== claim) throw cancellationError(`Claim ${claim} handed recovery to ${newest}. Stop that CLI, then use --apply --break-lock ${newest} --cancel-lock-queries.`)
}

async function writeRecoveryMarker(conn: Control, target: LockTarget, context: RecoveryContext, phase: 'required' | 'completed'): Promise<void> {
  const name = `${RECOVERY_PREFIX}${context.claim}/${phase}`
  const checksum = JSON.stringify(context)
  await conn.query(`INSERT INTO ${quoteIdentifier(target.database)}.${target.journalTable} (name, applied_at, checksum, chkit_version, migration_completed, operations) SELECT ${sqlString(name)}, now64(3), ${sqlString(checksum)}, ${sqlString(CLI_VERSION)}, false, [] SETTINGS async_insert = 0, insert_quorum = 'auto', insert_quorum_parallel = 0`)
  const rows = await variants(conn, source(target, context.identity), `name = ${sqlString(name)}`)
  if (rows.length !== 1 || rows[0]?.checksum !== checksum) throw cancellationError(`Recovery ${phase} marker did not read back; replacement work is blocked.`)
}

async function variants(conn: Control, from: string, predicate: string): Promise<Array<{ name: string; checksum: string }>> {
  const rows = await conn.query<{ name: string; variants: string }>(`SELECT name, toJSONString(groupUniqArray(checksum)) AS variants FROM ${from} WHERE ${predicate} GROUP BY name SETTINGS skip_unavailable_shards = 0, select_sequential_consistency = 1`)
  return rows.map((row) => {
    const checksums: unknown = JSON.parse(row.variants)
    if (!Array.isArray(checksums) || checksums.length !== 1 || typeof checksums[0] !== 'string') throw cancellationError('Conflicting or unreadable immutable cancellation records.')
    return { name: row.name, checksum: checksums[0] }
  })
}

async function writeMarker(db: ClickHouseExecutor, target: LockTarget, plan: CancellationPlan, phase: 'pending' | 'completed', conn = control(db)): Promise<void> {
  const name = `${CANCELLATION_PREFIX}${plan.claim}/${phase}`
  const checksum = JSON.stringify({ protocol: 1, claim: plan.claim, identity: plan.identity })
  await conn.query(`INSERT INTO ${quoteIdentifier(target.database)}.${target.journalTable} (name, applied_at, checksum, chkit_version, migration_completed, operations) SELECT ${sqlString(name)}, now64(3), ${sqlString(checksum)}, ${sqlString(CLI_VERSION)}, false, [] SETTINGS async_insert = 0, insert_quorum = 'auto', insert_quorum_parallel = 0`)
  const rows = await variants(conn, source(target, plan.identity), `name = ${sqlString(name)}`)
  if (rows.length !== 1 || rows[0]?.checksum !== checksum) throw cancellationError(`Cancellation ${phase} marker did not read back; replacement work is blocked.`)
}

function source(target: LockTarget, identity?: QueryIdentity): string {
  const cluster = identity?.cluster ?? target.fanout?.cluster
  return cluster ? `clusterAllReplicas(${sqlString(cluster)}, ${sqlString(target.database)}, ${sqlString(target.journalTable)})` : `${quoteIdentifier(target.database)}.${target.journalTable}`
}

function processPredicate(identity: QueryIdentity, ids: string[]): string {
  const list = ids.map(sqlString).join(',')
  return `((query_id IN (${list}) AND user = ${sqlString(identity.principal)}) OR (initial_query_id IN (${list}) AND initial_user = ${sqlString(identity.principal)}))`
}

function parseIdentity(value: unknown): QueryIdentity {
  if (!isObject(value) || value.protocol !== 1 || typeof value.principal !== 'string' || !value.principal || !Array.isArray(value.serverUUIDs) || value.serverUUIDs.length === 0 || value.serverUUIDs.some((uuid: unknown) => typeof uuid !== 'string' || !UUID.test(uuid)) || (value.cluster !== undefined && typeof value.cluster !== 'string')) throw cancellationError('Unsupported query tracking identity.')
  return { protocol: 1, principal: value.principal, serverUUIDs: value.serverUUIDs.map(String).sort(), ...(typeof value.cluster === 'string' ? { cluster: value.cluster } : {}) }
}

function sameIdentity(left: QueryIdentity, right: QueryIdentity): boolean {
  return left.principal === right.principal && left.cluster === right.cluster && JSON.stringify([...left.serverUUIDs].sort()) === JSON.stringify([...right.serverUUIDs].sort())
}

function requireCluster(identity: QueryIdentity): string {
  if (!identity.cluster) throw cancellationError('Cancellation requires a verified declared cluster.')
  return identity.cluster
}

function objectJSON(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw)
  if (!isObject(value)) throw cancellationError('Malformed cancellation metadata.')
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
