import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ClickHouseExecutor, QueryControlOptions } from '@chkit/clickhouse'
import { compareCodePoints, quoteIdentifier, statementFingerprint } from '@chkit/core'

import { claimsSelectSql, LOCK_ROW_PREFIX, type LockTarget, type MigrateLock } from './lock.js'
import { attestQueryTable, classifyQueryIntent, cancellationError, QUERY_INTENT_PREFIX, sqlString, type QueryContext, type QueryIdentity, type QueryIntent, type QueryTarget } from './query-intents.js'
import { CLI_VERSION } from '../../runtime/version.js'

export const RECOVERY_PREFIX = '__chkit_migrate_recovery__/'
export const CANCELLATION_PREFIX = '__chkit_migrate_cancel__/'
const DEADLINE_MS = 30_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Topology { identity: QueryIdentity }
interface Control { query<T>(sql: string, options?: QueryControlOptions): Promise<T[]>; remaining(): number }
export interface RecoveryObligation { migration: string; statementIndex: number; forwardFingerprint: string; target: QueryTarget; source?: QueryTarget }
export interface RecoveryContext { protocol: 1; claim: string; identity: QueryIdentity; parents: string[]; obligations: RecoveryObligation[] }
interface RecoveryRecord { context: RecoveryContext; checksum: string; completed: boolean }
export interface CancellationPlan { claim: string; holder: string; identity: QueryIdentity; resumePending: boolean; targets: QueryTarget[]; sources: QueryTarget[]; parents: string[]; obligations: RecoveryObligation[]; inherited: boolean }

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
  const intents = await validateIntents(conn, target, identity, claim, inherited !== undefined)
  const obligations = uniqueObligations([...(inherited?.context.obligations ?? []), ...obligationsFromIntents(intents)])
  await validateObligations(conn, identity, obligations, target)
  assertIntentsCovered(intents, obligations)
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
    if (classified.kind !== 'insert' || !classified.target) throw cancellationError(`Recovery requires supported synchronous INSERT/TRUNCATE pairs throughout ${context.migration}; no query was canceled.`)
    const metadata = { queryControl: <T>(sql: string) => conn.query<T>(sql) }
    const table = await attestQueryTable(metadata, plan.identity, classified.target)
    const sourceTable = classified.source ? await attestQueryTable(metadata, plan.identity, classified.source) : undefined
    const obligation = { migration: context.migration, statementIndex: context.statementIndex, forwardFingerprint: statementFingerprint(context.forwardSQL), target: table, ...(sourceTable ? { source: sourceTable } : {}) }
    await validateObligations(conn, plan.identity, [obligation], target)
    additions.push(obligation)
  }
  for (const inherited of plan.obligations) {
    if (!additions.some((item) => item.migration === inherited.migration && item.statementIndex === inherited.statementIndex)) await assertJournalCoverage(conn, target, plan.identity, [inherited])
  }
  const obligations = uniqueObligations([...plan.obligations, ...additions])
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
    if ((await validateIntents(conn, target, plan.identity, reservation.claim, true)).length !== 0) throw cancellationError('A competing recovery already recorded migration work; name its actual claim.')
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

/** No compensation or replacement statement may run until this returns. */
export async function cancelPredecessor(db: ClickHouseExecutor, target: LockTarget, plan: CancellationPlan, lock: MigrateLock): Promise<RecoveryContext> {
  let conn = control(db, lock)
  const { identity, claim } = plan
  await assertIdentityTopology(conn, identity)
  // A fresh read closes the validation-to-reservation interval. Validate the
  // entire set before the first KILL, so unsupported work is never guessed at.
  const history = await recoveryHistory(conn, target, identity)
  assertNoSuccessor(history, claim)
  if (plan.inherited && !history.get(claim)) throw cancellationError('The inherited recovery context disappeared.')
  const intents = await validateIntents(conn, target, identity, claim, plan.inherited)
  assertIntentsCovered(intents, plan.obligations)
  await validateObligations(conn, identity, plan.obligations, target)
  const ids = intents.map((intent) => intent.queryId)
  const predicate = processPredicate(identity, ids)
  const from = `clusterAllReplicas(${sqlString(requireCluster(identity))}, system.processes)`
  if (ids.length > 0) {
    const processes = await conn.query<{ query_id: string; initial_query_id: string; user: string; initial_user: string }>(
      `SELECT query_id, initial_query_id, user, initial_user FROM ${from} WHERE query_id IN (${ids.map(sqlString).join(',')}) OR initial_query_id IN (${ids.map(sqlString).join(',')}) SETTINGS skip_unavailable_shards = 0`,
    )
    for (const row of processes) {
      if ((ids.includes(row.query_id) && row.user !== identity.principal) || (ids.includes(row.initial_query_id) && row.initial_user !== identity.principal)) {
        throw cancellationError('A recorded query id belongs to another SQL principal; no query was canceled.')
      }
    }
  }
  // Fixed phase boundaries only: every receipt/terminal loop shares one
  // absolute budget. No phase starts after the previous one failed.
  lock.assertHeld()
  conn = control(db, lock)
  if (ids.length > 0) {
    await killWithReceipts(conn, identity, ids)
    for (;;) {
      await assertIdentityTopology(conn, identity)
      const running = await conn.query<{ n: string | number }>(`SELECT count() AS n FROM ${from} WHERE ${predicate} SETTINGS skip_unavailable_shards = 0`)
      if (running.length !== 1 || !Number.isFinite(Number(running[0]?.n))) throw cancellationError('Cannot verify query termination on every server.')
      if (Number(running[0]?.n) === 0) break
      await sleep(Math.min(100, conn.remaining()))
    }
  }
  lock.assertHeld()
  conn = control(db, lock)
  const activeClaim = lock.claimId
  if (!activeClaim || !UUID.test(activeClaim)) throw cancellationError('The replacement lock has no valid claim identity.')
  const context: RecoveryContext = { protocol: 1, claim: activeClaim, identity, parents: [...new Set([claim, ...plan.parents])].sort(), obligations: plan.obligations }
  // Issuance attests predecessor termination. This barrier is durable BEFORE
  // old completion and BEFORE even the first replacement intent/user send.
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
  await validateObligations(conn, context.identity, context.obligations, target)
  const ownIntents = await validateIntents(conn, target, context.identity, context.claim, true)
  const obligations = uniqueObligations([...context.obligations, ...obligationsFromIntents(ownIntents)])
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

/** The backend fence prevents a detached old PG commit from registering after TRUNCATE. */
export async function settleCompensation(db: ClickHouseExecutor, plan: CancellationPlan, table: QueryTarget, lock: MigrateLock): Promise<void> {
  const conn = control(db, lock)
  await assertIdentityTopology(conn, plan.identity)
  await validateTable(conn, plan.identity, table, false)
  if (table.engine !== 'SharedMergeTree') return
  for (;;) {
    await assertSharedFence(conn, plan.identity)
    const rows = await conn.query<{ server_uuid: string; principal: string; n: string | number }>(
      `SELECT server_uuid, principal, n FROM clusterAllReplicas(${sqlString(requireCluster(plan.identity))}, view(SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal, toString(sum(rows)) AS n FROM system.parts WHERE database = ${sqlString(table.database)} AND table = ${sqlString(table.name)} AND active)) SETTINGS skip_unavailable_shards = 0`,
    )
    if (JSON.stringify(rows.map((row) => row.server_uuid).sort()) !== JSON.stringify([...plan.identity.serverUUIDs].sort()) || rows.some((row) => row.principal !== plan.identity.principal || !Number.isFinite(Number(row.n)) || Number(row.n) < 0)) throw cancellationError('Cannot verify compensation storage state on every server.')
    if (rows.every((row) => Number(row.n) === 0)) break
    await sleep(Math.min(100, conn.remaining()))
  }
  await assertIdentityTopology(conn, plan.identity)
  await validateTable(conn, plan.identity, table, false)
  lock.assertHeld()
}

async function assertSharedFence(conn: Control, identity: QueryIdentity): Promise<void> {
  const rows = await conn.query<{ server_uuid: string; principal: string; version: string | number }>(
    `SELECT server_uuid, principal, version FROM clusterAllReplicas(${sqlString(requireCluster(identity))}, view(SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal, toString(sharedMergeTreeTruncateFenceVersion()) AS version FROM system.one)) SETTINGS skip_unavailable_shards = 0`,
  )
  if (JSON.stringify(rows.map((row) => row.server_uuid).sort()) !== JSON.stringify([...identity.serverUUIDs].sort()) || rows.some((row) => row.principal !== identity.principal || String(row.version) !== '1')) throw cancellationError('Every replica must enable SharedMergeTree truncate-fence protocol 1 before cancellation recovery.')
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

/** Receipts prove each physical member executed its own local KILL. No ON CLUSTER/Keeper is assumed. */
export async function killWithReceipts(conn: Control, identity: QueryIdentity, ids: string[]): Promise<void> {
  if (ids.length === 0 || ids.some((id) => !UUID.test(id))) throw cancellationError('Cancellation requires exact recorded query ids.')
  const controls: string[] = []
  const covered = new Set<string>()
  while (covered.size !== identity.serverUUIDs.length) {
    await assertIdentityTopology(conn, identity)
    // Keep a full burst together: interleaving one receipt read per KILL can
    // pin every KILL to the same member of a round-robin endpoint.
    for (let attempt = 0; attempt < identity.serverUUIDs.length; attempt++) {
      const controlId = randomUUID()
      controls.push(controlId)
      try {
        await conn.query(`KILL QUERY WHERE ${processPredicate(identity, ids)} AND ${identityGuard(identity)} SYNC`, {
          queryId: controlId,
          settings: { log_queries: 1, log_queries_probability: 1, log_queries_min_query_duration_ms: 0 },
        })
      } catch (error) {
        // An empty KILL can be NOTHING_TO_KILL on some versions. Only a successful
        // QueryFinish receipt counts; the exception alone never supplies coverage.
        if (!isNothingToKill(error)) throw error
      }
    }
    const receipts = await conn.query<{ server_uuid: string; principal: string; query_id: string }>(
      `SELECT server_uuid, principal, query_id FROM clusterAllReplicas(${sqlString(requireCluster(identity))}, view(SELECT toString(serverUUID()) AS server_uuid, user AS principal, query_id FROM system.query_log WHERE event_date >= today() - 1 AND event_time >= now() - INTERVAL 5 MINUTE AND query_id IN (${controls.map(sqlString).join(',')}) AND type = 'QueryFinish' AND exception_code = 0 AND user = ${sqlString(identity.principal)})) SETTINGS skip_unavailable_shards = 0`,
    )
    for (const row of receipts) {
      if (!identity.serverUUIDs.includes(row.server_uuid) || row.principal !== identity.principal || !controls.includes(row.query_id)) throw cancellationError('A KILL receipt has an unexpected server, principal or query id.')
      covered.add(row.server_uuid)
    }
    if (covered.size !== identity.serverUUIDs.length) await sleep(Math.min(100, conn.remaining()))
  }
  await assertIdentityTopology(conn, identity)
}

async function assertIdentityTopology(conn: Control, identity: QueryIdentity): Promise<Topology> {
  const current = await topology(conn, requireCluster(identity))
  if (!sameIdentity(current.identity, identity)) throw cancellationError('The SQL principal or server topology changed; replacement work is blocked.')
  return current
}

async function validateIntents(conn: Control, target: LockTarget, identity: QueryIdentity, claim: string, allowEmpty = false): Promise<QueryIntent[]> {
  const prefix = `${QUERY_INTENT_PREFIX}${claim}/`
  const rows = await variants(conn, source(target, identity), `startsWith(name, ${sqlString(prefix)})`)
  if (rows.length === 0 && !allowEmpty) throw cancellationError('The predecessor has no cancellable tracked queries.')
  const intents: QueryIntent[] = []
  for (const row of rows) {
    const data = objectJSON(row.checksum)
    const queryId = row.name.slice(prefix.length)
    const recordedIdentity = parseIdentity(data)
    if (!UUID.test(queryId) || data.queryId !== queryId || data.claim !== claim || !sameIdentity(recordedIdentity, identity) || !['forward', 'compensation'].includes(String(data.phase)) || !['insert', 'truncate'].includes(String(data.kind)) || typeof data.migration !== 'string' || !Number.isInteger(data.statementIndex) || Number(data.statementIndex) < 0 || typeof data.fingerprint !== 'string' || !/^v1:[0-9a-f]{64}$/.test(data.fingerprint) || typeof data.forwardFingerprint !== 'string' || !/^v1:[0-9a-f]{64}$/.test(data.forwardFingerprint) || (data.phase === 'forward' && data.fingerprint !== data.forwardFingerprint)) {
      throw cancellationError('The predecessor contains unsupported, async or malformed query intents; no query was canceled.')
    }
    assertNotJournal(target, recordedTable(data.target))
    if (data.source !== undefined) assertNotJournal(target, recordedTable(data.source))
    const table = await validateTable(conn, identity, data.target, false)
    const sourceTable = data.source === undefined ? undefined : await validateTable(conn, identity, data.source, true)
    if (sourceTable && sourceTable.uuid === table.uuid) throw cancellationError('The compensation would truncate its own source; replacement work is blocked.')
    intents.push({ ...recordedIdentity, claim, queryId, migration: data.migration, statementIndex: Number(data.statementIndex), phase: data.phase === 'forward' ? 'forward' : 'compensation', kind: data.kind === 'insert' ? 'insert' : 'truncate', fingerprint: data.fingerprint, forwardFingerprint: data.forwardFingerprint, target: table, ...(sourceTable ? { source: sourceTable } : {}) })
  }
  return intents
}

async function validateTable(conn: Control, identity: QueryIdentity, value: unknown, sourceTable: boolean): Promise<QueryTarget> {
  if (!isObject(value) || typeof value.database !== 'string' || typeof value.name !== 'string' || !value.database || !value.name) throw cancellationError('A query intent has no valid SQL table.')
  if (typeof value.uuid !== 'string' || !UUID.test(value.uuid) || value.uuid === '00000000-0000-0000-0000-000000000000' || typeof value.engine !== 'string') throw cancellationError('A table source or target has no recorded storage identity.')
  const metadata = await conn.query<{ server_uuid: string; principal: string; uuid: string; engine: string; dependencies: string }>(
    `SELECT server_uuid, principal, uuid, engine, dependencies FROM clusterAllReplicas(${sqlString(requireCluster(identity))}, view(SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal, toString(uuid) AS uuid, engine, toJSONString(dependencies_table) AS dependencies FROM system.tables WHERE database = ${sqlString(value.database)} AND name = ${sqlString(value.name)})) SETTINGS skip_unavailable_shards = 0`,
  )
  const engines = sourceTable ? ['MergeTree', 'ReplicatedMergeTree', 'SharedMergeTree'] : ['MergeTree', 'SharedMergeTree']
  if (metadata.length !== identity.serverUUIDs.length || metadata.some((row) => !engines.includes(row.engine) || row.dependencies !== '[]') || (!sourceTable && value.engine === 'MergeTree' && identity.serverUUIDs.length !== 1)) throw cancellationError('Cancellation requires a plain MergeTree target on one declared server, or a supported SharedMergeTree target, without materialized-view dependencies.')
  if (JSON.stringify(metadata.map((row) => row.server_uuid).sort()) !== JSON.stringify([...identity.serverUUIDs].sort()) || metadata.some((row) => row.principal !== identity.principal || row.uuid !== value.uuid || row.engine !== value.engine)) throw cancellationError('A recorded source or target identity changed; replacement work is blocked.')
  if (!sourceTable && value.engine === 'SharedMergeTree') await assertSharedFence(conn, identity)
  return { database: value.database, name: value.name, uuid: value.uuid, engine: value.engine }
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

async function validateObligations(conn: Control, identity: QueryIdentity, obligations: RecoveryObligation[], journal: LockTarget): Promise<void> {
  if (obligations.length === 0) throw cancellationError('Recovery has no complete forward obligations.')
  for (const item of obligations) {
    assertNotJournal(journal, item.target)
    if (item.source) assertNotJournal(journal, item.source)
    await validateTable(conn, identity, item.target, false)
    if (item.source) await validateTable(conn, identity, item.source, true)
  }
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

function identityGuard(identity: QueryIdentity): string {
  return `throwIf(currentUser() != ${sqlString(identity.principal)} OR NOT has([${identity.serverUUIDs.map(sqlString).join(',')}], toString(serverUUID())), 'Cancellation SQL identity or server mismatch') = 0`
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

function isNothingToKill(error: unknown): boolean {
  return error instanceof Error && /\bNOTHING_TO_KILL\b/.test(error.message)
}
