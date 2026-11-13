import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { quoteIdentifier } from '@chkit/core'

import { claimsSelectSql, LOCK_ROW_PREFIX, type LockTarget, type MigrateLock } from './lock.js'
import { cancellationError, QUERY_INTENT_PREFIX, sqlString, type QueryIdentity, type QueryIntent } from './query-intents.js'
import { CLI_VERSION } from '../../runtime/version.js'

export const CANCELLATION_PREFIX = '__chkit_migrate_cancel__/'
const DEADLINE_MS = 30_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Topology { identity: QueryIdentity; hosts: string[] }
interface Control { query<T>(sql: string): Promise<T[]>; remaining(): number }
export interface CancellationPlan { claim: string; holder: string; identity: QueryIdentity; resumePending: boolean }

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
  if (identity.serverUUIDs.length !== 1) throw cancellationError('Cancellation recovery currently requires one declared server; plain MergeTree compensation cannot cover independent replica tables.')
  const conn = control(db)
  await assertIdentityTopology(conn, identity)
  const rows = await conn.query<{ name: string; holder: string }>(claimsSelectSql({ ...target, fanout: { cluster: requireCluster(identity), replicas: identity.serverUUIDs.length } }, `${LOCK_ROW_PREFIX}${claim}`))
  const predecessor = rows.find((row) => row.name === `${LOCK_ROW_PREFIX}${claim}`)
  if (!predecessor) throw cancellationError('The named predecessor claim is missing; no query was canceled.')
  const holder = objectJSON(predecessor.holder)
  const recorded = parseIdentity(holder.queries)
  if (!sameIdentity(recorded, identity)) throw cancellationError('The predecessor is untracked, uses another SQL principal, or belongs to another topology.')
  await validateIntents(conn, target, identity, claim)
  const markers = await variants(conn, source(target, identity), `startsWith(name, ${sqlString(`${CANCELLATION_PREFIX}${claim}/`)})`)
  if (markers.some((row) => row.name.endsWith('/completed'))) throw cancellationError('This predecessor cancellation already completed. Name the actual newer stopped claim instead, or run ordinary apply.')
  return { claim, holder: predecessor.holder, identity, resumePending: markers.some((row) => row.name.endsWith('/pending')) }
}

/** Called under the new reservation before reclaiming a crashed successor. */
export async function assertCancellationUnfinished(db: ClickHouseExecutor, target: LockTarget, plan: CancellationPlan): Promise<void> {
  const rows = await variants(control(db), source(target, plan.identity), `startsWith(name, ${sqlString(`${CANCELLATION_PREFIX}${plan.claim}/`)})`)
  if (!rows.some((row) => row.name.endsWith('/pending')) || rows.some((row) => row.name.endsWith('/completed'))) {
    throw cancellationError('Cancellation is not durably unfinished; another owner may have admitted its own queries.')
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
    if (completed === undefined && claim !== allowedClaim) throw cancellationError(`Cancellation of claim ${claim} is unfinished. Stop its old CLI, then resume with --apply --break-lock ${claim} --cancel-lock-queries.`)
  }
}

/** No compensation or replacement statement may run until this returns. */
export async function cancelPredecessor(db: ClickHouseExecutor, target: LockTarget, plan: CancellationPlan, lock: MigrateLock): Promise<void> {
  const conn = control(db, lock)
  const { identity, claim } = plan
  if (identity.serverUUIDs.length !== 1) throw cancellationError('Cancellation recovery requires a verified single server.')
  await assertIdentityTopology(conn, identity)
  // A fresh read closes the validation-to-reservation interval. Validate the
  // entire set before the first KILL, so unsupported work is never guessed at.
  const intents = await validateIntents(conn, target, identity, claim)
  const ids = intents.map((intent) => intent.queryId)
  const predicate = processPredicate(identity, ids)
  const from = `clusterAllReplicas(${sqlString(requireCluster(identity))}, system.processes)`
  const processes = await conn.query<{ query_id: string; initial_query_id: string; user: string; initial_user: string }>(
    `SELECT query_id, initial_query_id, user, initial_user FROM ${from} WHERE query_id IN (${ids.map(sqlString).join(',')}) OR initial_query_id IN (${ids.map(sqlString).join(',')}) SETTINGS skip_unavailable_shards = 0`,
  )
  for (const row of processes) {
    if ((ids.includes(row.query_id) && row.user !== identity.principal) || (ids.includes(row.initial_query_id) && row.initial_user !== identity.principal)) {
      throw cancellationError('A recorded query id belongs to another SQL principal; no query was canceled.')
    }
  }
  try {
    await conn.query(`KILL QUERY WHERE ${predicate} AND ${identityGuard(identity)} SYNC`)
  } catch (error) {
    // Newer servers may report NOTHING_TO_KILL instead of an empty result.
    // It never substitutes for the subsequent strict all-node terminal proof.
    if (!isNothingToKill(error)) throw error
  }
  for (;;) {
    await assertIdentityTopology(conn, identity)
    const running = await conn.query<{ n: string | number }>(`SELECT count() AS n FROM ${from} WHERE ${predicate} SETTINGS skip_unavailable_shards = 0`)
    if (running.length !== 1 || !Number.isFinite(Number(running[0]?.n))) throw cancellationError('Cannot verify query termination on every server.')
    if (Number(running[0]?.n) === 0) break
    await sleep(Math.min(100, conn.remaining()))
  }
  lock.assertHeld()
  await writeMarker(db, target, plan, 'completed', conn)
  lock.assertHeld()
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
  return { remaining, async query<T>(sql: string) { const rows = await query<T>(sql, remaining()); remaining(); return rows } }
}

function controlOrQuery(db: ClickHouseExecutor): Control {
  return db.queryControl && db.commandTracked ? control(db) : { query: (sql) => db.query(sql), remaining: () => DEADLINE_MS }
}

async function topology(conn: Control, cluster: string): Promise<Topology> {
  const snapshotSQL = `SELECT host_name AS host, toString(port) AS port, toString(shard_num) AS shard, toString(replica_num) AS replica FROM system.clusters WHERE cluster = ${sqlString(cluster)} ORDER BY shard, replica, host, port`
  const before = await conn.query<{ host: string; port: string; shard: string; replica: string }>(snapshotSQL)
  if (before.length === 0) throw cancellationError('The declared cancellation cluster is missing or unreadable.')
  const nodesSQL = `SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal FROM clusterAllReplicas(${sqlString(cluster)}, system.one) SETTINGS skip_unavailable_shards = 0`
  const localSQL = 'SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal'
  const local = await conn.query<{ server_uuid: string; principal: string }>(localSQL)
  const nodes = await conn.query<{ server_uuid: string; principal: string }>(nodesSQL)
  const after = await conn.query(snapshotSQL)
  const confirmed = await conn.query<{ server_uuid: string; principal: string }>(nodesSQL)
  const localAfter = await conn.query<{ server_uuid: string; principal: string }>(localSQL)
  const nodeKey = (rows: typeof nodes) => rows.map((row) => `${row.server_uuid}/${row.principal}`).sort()
  const uuids = nodes.map((row) => row.server_uuid).sort()
  const principal = nodes[0]?.principal
  const hosts = before.map((row) => `${row.host}:${row.port}`).sort()
  if (!principal || local.length !== 1 || local[0]?.principal !== principal || !uuids.includes(local[0]?.server_uuid ?? '') || JSON.stringify(local) !== JSON.stringify(localAfter) || nodes.length !== before.length || new Set(uuids).size !== before.length || new Set(hosts).size !== before.length || uuids.some((uuid) => !UUID.test(uuid)) || nodes.some((row) => row.principal !== principal) || JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(nodeKey(nodes)) !== JSON.stringify(nodeKey(confirmed))) {
    throw cancellationError('Cancellation cannot establish stable, complete same-principal replica coverage.')
  }
  return { identity: { protocol: 1, principal, serverUUIDs: uuids, cluster }, hosts }
}

async function assertIdentityTopology(conn: Control, identity: QueryIdentity): Promise<Topology> {
  const current = await topology(conn, requireCluster(identity))
  if (!sameIdentity(current.identity, identity)) throw cancellationError('The SQL principal or server topology changed; replacement work is blocked.')
  return current
}

async function validateIntents(conn: Control, target: LockTarget, identity: QueryIdentity, claim: string): Promise<QueryIntent[]> {
  const prefix = `${QUERY_INTENT_PREFIX}${claim}/`
  const rows = await variants(conn, source(target, identity), `startsWith(name, ${sqlString(prefix)})`)
  if (rows.length === 0) throw cancellationError('The predecessor has no cancellable tracked queries.')
  const intents: QueryIntent[] = []
  for (const row of rows) {
    const data = objectJSON(row.checksum)
    const queryId = row.name.slice(prefix.length)
    const recordedIdentity = parseIdentity(data)
    if (!UUID.test(queryId) || data.queryId !== queryId || data.claim !== claim || !sameIdentity(recordedIdentity, identity) || !['forward', 'compensation'].includes(String(data.phase)) || !['insert', 'truncate'].includes(String(data.kind)) || typeof data.migration !== 'string' || !Number.isInteger(data.statementIndex) || Number(data.statementIndex) < 0 || typeof data.fingerprint !== 'string' || !/^v1:[0-9a-f]{64}$/.test(data.fingerprint)) {
      throw cancellationError('The predecessor contains unsupported, async or malformed query intents; no query was canceled.')
    }
    const table = data.target
    if (!isObject(table) || typeof table.database !== 'string' || typeof table.name !== 'string' || !table.database || !table.name) throw cancellationError('A query intent has no valid SQL target.')
    const metadata = await conn.query<{ engine: string; dependencies: string }>(
      `SELECT engine, toJSONString(dependencies_table) AS dependencies FROM clusterAllReplicas(${sqlString(requireCluster(identity))}, system.tables) WHERE database = ${sqlString(table.database)} AND name = ${sqlString(table.name)} SETTINGS skip_unavailable_shards = 0`,
    )
    // Broader engine guarantees need their own replication/background proof.
    if (metadata.length !== identity.serverUUIDs.length || metadata.some((item) => item.engine !== 'MergeTree' || item.dependencies !== '[]')) {
      throw cancellationError('Cancellation currently requires plain MergeTree targets without materialized-view dependencies on every server.')
    }
    intents.push({ ...recordedIdentity, claim, queryId, migration: data.migration, statementIndex: Number(data.statementIndex), phase: data.phase === 'forward' ? 'forward' : 'compensation', kind: data.kind === 'insert' ? 'insert' : 'truncate', fingerprint: data.fingerprint, target: { database: table.database, name: table.name } })
  }
  return intents
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
