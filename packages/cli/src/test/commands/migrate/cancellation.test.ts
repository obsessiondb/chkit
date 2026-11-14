import { describe, expect, test } from 'bun:test'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { statementFingerprint } from '@chkit/core'

import { assertCancellationClear, cancelPredecessor, markCancellationPending, prepareCancellation, resolveQueryIdentity, settleCompensation, finishRecovery, expandRecoveryPlan, assertCancellationUnfinished, RECOVERY_PREFIX, CANCELLATION_PREFIX, REPLACE_PREFIX } from '../../../commands/migrate/cancellation.js'
import type { QueryIdentity, QueryIntent, QueryTarget } from '../../../commands/migrate/query-intents.js'
import { QUERY_INTENT_PREFIX } from '../../../commands/migrate/query-intents.js'
import type { MigrateLock } from '../../../commands/migrate/lock.js'

const CLAIM = '00000000-0000-4000-8000-000000000001'
const ID = '00000000-0000-4000-8000-000000000002'
const NEXT = '00000000-0000-4000-8000-000000000007'
const SOURCE = '00000000-0000-4000-8000-000000000006'
const SUCCESSOR = '00000000-0000-4000-8000-000000000005'
const SERVER = '00000000-0000-4000-8000-000000000003'
const REPLACED = '00000000-0000-4000-8000-000000000009'
const IDENTITY: QueryIdentity = { protocol: 1, principal: 'writer', serverUUIDs: [SERVER], cluster: 'declared' }
const TARGET = { database: 'app', journalTable: '_chkit_migrations', fanout: undefined }

function targetTable(tables: QueryTarget[]): QueryTarget {
  const table = tables[0]
  if (!table) throw new Error('Missing recorded table')
  return table
}

function fake(identity: QueryIdentity = IDENTITY) {
  const markers = new Map<string, string>()
  const calls: Array<{ sql: string; timeout: number }> = []
  const intent: QueryIntent = { ...identity, claim: CLAIM, queryId: ID, migration: 'load.sql', statementIndex: 0,
    phase: 'forward', kind: 'insert', fingerprint: statementFingerprint('INSERT INTO app.events SELECT 1'), forwardFingerprint: statementFingerprint('INSERT INTO app.events SELECT 1'), target: { database: 'app', name: 'events', uuid: ID, engine: 'MergeTree' } }
  const compensation: QueryIntent = { ...intent, queryId: NEXT, phase: 'compensation', kind: 'replace', fingerprint: statementFingerprint('CREATE OR REPLACE TABLE app.events AS app.events') }
  const intents = new Map<string, QueryIntent[]>([[CLAIM, [intent]]])
  const state = { failRequired: '', failRecoveryCompletion: '', journalOperations: [] as unknown[], metricsUUID: SOURCE, journalCompleted: false, recordedEngine: 'MergeTree', source: false, sourceUUID: SOURCE, sourceEngine: 'MergeTree', targetUUID: ID, kind: 'insert', engine: 'MergeTree', databaseEngine: 'Atomic', dependencies: '[]', principal: 'writer', server: SERVER,
    localServer: SERVER, localPrincipal: 'writer', grants: [{ access_type: 'ALL', database: null, table: null, is_partial_revoke: 0 }] as unknown[],
    replaceAfterReads: -1, replacedServers: [] as string[], tableReads: 0, compensated: false, untracked: false,
    loseAfterKill: false, killFailure: false, failCompletion: false, held: true, killed: false, unreadable: false, legacy: false }
  const db = {
    queryControlCluster: 'declared',
    commandTracked: async () => {},
    async queryControl(sql: string, timeout: number) {
      calls.push({ sql, timeout })
      if (state.unreadable) throw new Error('replica unreadable')
      if (sql.includes('FROM system.clusters')) return [{ host: 'host', port: '9000', shard: '1', replica: '1' }]
      if (sql.includes('system.grants')) return state.grants
      if (sql.includes('system.one')) return identity.serverUUIDs.map((server_uuid, index) => ({ server_uuid: index === 0 ? state.server : server_uuid, principal: state.principal }))
      if (sql === 'SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal') return [{ server_uuid: state.localServer, principal: state.localPrincipal }]
      if (sql.includes('argMax(tuple(applied_at')) return [CLAIM, SUCCESSOR, NEXT].map((claim) => ({ name: `__chkit_migrate_lock__/${claim}`, holder: JSON.stringify(state.legacy ? {} : { queries: identity }) }))
      if (sql.startsWith('INSERT INTO')) {
        const match = /SELECT '([^']+)', now64\(3\), '((?:[^'\\]|\\.)*)'/.exec(sql)
        if (!match) throw new Error('unexpected marker INSERT')
        if (state.failCompletion && match[1]?.endsWith('/completed')) throw new Error('completion unavailable')
        const required = match[1]?.startsWith(RECOVERY_PREFIX) && match[1]?.endsWith('/required')
        const completedRecovery = match[1]?.startsWith(RECOVERY_PREFIX) && match[1]?.endsWith('/completed')
        if (required && state.failRequired === 'before') throw new Error('required absent')
        markers.set(match[1] ?? '', (match[2] ?? '').replace(/\\(.)/g, '$1'))
        if (required && state.failRequired === 'after') throw new Error('required ACK lost')
        if (completedRecovery && state.failRecoveryCompletion === 'after') throw new Error('recovery completion ACK lost')
        return []
      }
      if (sql.includes('groupUniqArray(checksum)')) {
        if (sql.includes(QUERY_INTENT_PREFIX)) {
          const claim = [CLAIM, SUCCESSOR, NEXT].find((value) => sql.includes(`${QUERY_INTENT_PREFIX}${value}/`)) ?? ''
          const recorded = claim === CLAIM && state.compensated ? [...(intents.get(claim) ?? []), compensation] : intents.get(claim) ?? []
          if (claim === CLAIM && state.untracked) return [{ name: `${QUERY_INTENT_PREFIX}${claim}/untracked`, variants: JSON.stringify([JSON.stringify({ protocol: 1, claim })]) }]
          return recorded.map((item) => ({ name: `${QUERY_INTENT_PREFIX}${claim}/${item.queryId}`, variants: JSON.stringify([JSON.stringify(claim === CLAIM ? { ...item, target: { ...item.target, engine: state.recordedEngine }, kind: item.phase === 'forward' ? state.kind : item.kind, ...(state.source ? { source: { database: 'app', name: 'frozen', uuid: SOURCE, engine: 'MergeTree' } } : {}) } : item)]) }))
        }
        const prefix = /startsWith\(name, '([^']+)'\)/.exec(sql)?.[1]
        return [...markers].filter(([name]) => (!prefix || name.startsWith(prefix)) && (!sql.includes('name = ') || sql.includes(`name = '${name}'`))).map(([name, checksum]) => ({ name, variants: JSON.stringify([checksum]) }))
      }
      if (sql.includes('arrayMap((op, fp)')) return [{ name: 'load.sql', migration_completed: state.journalCompleted ? '1' : '0', operations: JSON.stringify(state.journalOperations.length ? state.journalOperations : [[0, 'completed', intent.forwardFingerprint]]) }]
      if (sql.includes('system.tables')) {
        const events = !sql.includes("name = 'frozen'") && !sql.includes("name = 'metrics'")
        if (events && ++state.tableReads === state.replaceAfterReads) state.targetUUID = REPLACED
        return identity.serverUUIDs.map((server_uuid) => ({ server_uuid, principal: state.principal, uuid: sql.includes("name = 'frozen'") ? state.sourceUUID : sql.includes("name = 'metrics'") ? state.metricsUUID : state.replacedServers.includes(server_uuid) ? REPLACED : state.targetUUID, engine: sql.includes("name = 'frozen'") ? state.sourceEngine : state.engine, dependencies: state.dependencies, database_engine: state.databaseEngine }))
      }
      if (sql.startsWith('SELECT query_id')) return [{ query_id: ID, initial_query_id: ID, user: 'writer', initial_user: 'writer' }]
      if (sql.startsWith('KILL QUERY')) {
        if (state.killFailure) throw new Error('KILL denied')
        state.killed = true
        if (state.loseAfterKill) state.held = false
        return [{ kill_status: 'finished' }]
      }
      throw new Error(`unexpected control SQL: ${sql}`)
    },
  } as unknown as ClickHouseExecutor
  const lock: MigrateLock = { claimId: SUCCESSOR, assertHeld() { if (!state.held) throw new Error('lost ownership') }, release: async () => {} }
  return { db, state, calls, markers, lock, intents }
}

describe('explicit predecessor cancellation (#732)', () => {
  test('a failed KILL does not block recovery, the replace is the safety gate', async () => {
    const f = fake()
    const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    f.state.killFailure = true
    await markCancellationPending(f.db, TARGET, plan)
    await cancelPredecessor(f.db, TARGET, plan, f.lock)
    expect(f.calls.filter((call) => call.sql.startsWith('KILL'))).toHaveLength(1)
    expect(f.calls.find((call) => call.sql.startsWith('KILL'))?.sql).toContain('ASYNC')
    expect(f.markers.has(`${CANCELLATION_PREFIX}${CLAIM}/completed`)).toBe(true)
  })

  test('pending cancellation blocks later ordinary/no-pending owners until terminal proof completes', async () => {
    const f = fake()
    expect(await resolveQueryIdentity(f.db)).toEqual(IDENTITY)
    const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    await markCancellationPending(f.db, TARGET, plan)
    await expect(assertCancellationClear(f.db, TARGET)).rejects.toThrow('unfinished')
    // Even a failed identity lookup must retain the declared transport cluster.
    expect(f.calls.at(-1)?.sql).toContain("clusterAllReplicas('declared'")
    await assertCancellationClear(f.db, TARGET, CLAIM)
    const recovery = await cancelPredecessor(f.db, TARGET, plan, f.lock)
    expect(f.state.killed).toBe(true)
    expect(f.markers.has(`${CANCELLATION_PREFIX}${CLAIM}/completed`)).toBe(true)
    await expect(assertCancellationClear(f.db, TARGET)).rejects.toThrow('Recovery')
    await expect(finishRecovery(f.db, TARGET, recovery, f.lock)).rejects.toThrow('unchanged SQL')
    f.state.journalCompleted = true
    await finishRecovery(f.db, TARGET, recovery, f.lock)
    await assertCancellationClear(f.db, TARGET)
    await expect(prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)).rejects.toThrow('already completed')
    const killIndex = f.calls.findIndex((call) => call.sql.startsWith('KILL'))
    const completeIndex = f.calls.findIndex((call) => call.sql.startsWith('INSERT') && call.sql.includes('/completed'))
    expect(completeIndex).toBeGreaterThan(killIndex)
  })

  for (const failure of ['failCompletion', 'held', 'loseAfterKill'] as const) {
    test(`failure leaves a durable barrier before replacement SQL (${failure})`, async () => {
      const f = fake()
      const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
      await markCancellationPending(f.db, TARGET, plan)
      if (failure === 'held') f.state.held = false
      else f.state[failure] = true
      await expect(cancelPredecessor(f.db, TARGET, plan, f.lock)).rejects.toThrow()
      expect(f.markers.has(`${CANCELLATION_PREFIX}${CLAIM}/completed`)).toBe(false)
      await expect(assertCancellationClear(f.db, TARGET)).rejects.toThrow('unfinished')
    })
  }

  for (const failure of ['async', 'unsupported', 'SharedMergeTree', 'materialized view', 'legacy', 'principal', 'endpoint', 'endpoint principal', 'unreadable', 'Ordinary database', 'no DROP grant', 'revoked CREATE'] as const) {
    test(`refuses before any KILL or takeover (${failure})`, async () => {
      const f = fake()
      if (failure === 'Ordinary database') f.state.databaseEngine = 'Ordinary'
      if (failure === 'no DROP grant') f.state.grants = [{ access_type: 'CREATE TABLE', database: 'app', table: null, is_partial_revoke: 0 }]
      if (failure === 'revoked CREATE') f.state.grants = [...f.state.grants, { access_type: 'CREATE', database: 'app', table: 'events', is_partial_revoke: 1 }]
      if (failure === 'async' || failure === 'unsupported') f.state.kind = failure
      if (failure === 'SharedMergeTree') f.state.engine = failure
      if (failure === 'materialized view') f.state.dependencies = '["mv"]'
      if (failure === 'legacy') f.state.legacy = true
      if (failure === 'principal') f.state.principal = 'another'
      if (failure === 'endpoint') f.state.localServer = ID
      if (failure === 'endpoint principal') f.state.localPrincipal = 'another'
      if (failure === 'unreadable') f.state.unreadable = true
      await expect(prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)).rejects.toThrow()
      expect(f.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
    })
  }

  for (const fault of ['source recreated', 'target recreated', 'distributed source', 'view source'] as const) {
    test(`refuses a changed or unsafe table identity before takeover (${fault})`, async () => {
      const f = fake()
      f.state.source = true
      if (fault === 'source recreated') f.state.sourceUUID = SERVER
      if (fault === 'target recreated') f.state.targetUUID = SERVER
      if (fault === 'distributed source') f.state.sourceEngine = 'Distributed'
      if (fault === 'view source') f.state.sourceEngine = 'View'
      await expect(prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)).rejects.toThrow()
      expect(f.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
    })
  }

  test('refuses a predecessor that ran untracked statements', async () => {
    const f = fake()
    f.state.untracked = true
    await expect(prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)).rejects.toThrow('could not track')
    expect(f.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
  })

  test('refuses multi-node plain MergeTree compensation and malformed claims', async () => {
    const identity = { ...IDENTITY, serverUUIDs: [SERVER, ID] }
    const f = fake(identity)
    await expect(prepareCancellation(f.db, TARGET, identity, CLAIM)).rejects.toThrow('one declared server')
    await expect(prepareCancellation(f.db, TARGET, IDENTITY, 'unknown')).rejects.toThrow('UUID')
    expect(f.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
  })
})

describe('replace settlement', () => {
  const other = '00000000-0000-4000-8000-000000000004'
  const identity = { ...IDENTITY, serverUUIDs: [SERVER, other] }

  test('waits for every replica to serve the new UUID, then records it before the reload', async () => {
    const f = fake(identity)
    f.state.engine = 'SharedMergeTree'
    f.state.recordedEngine = 'SharedMergeTree'
    const plan = await prepareCancellation(f.db, TARGET, identity, CLAIM)
    expect(plan.targets[0]).toMatchObject({ uuid: ID, engine: 'SharedMergeTree' })
    f.state.replacedServers = [SERVER]
    f.state.replaceAfterReads = f.state.tableReads + 2
    const replaced = await settleCompensation(f.db, TARGET, plan, targetTable(plan.targets), f.lock)
    expect(replaced).toEqual({ database: 'app', name: 'events', uuid: REPLACED, engine: 'SharedMergeTree' })
    expect(JSON.parse(f.markers.get(`${REPLACE_PREFIX}${ID}`) ?? '{}')).toMatchObject({ from: ID, uuid: REPLACED })
    // Later reads resolve the recorded UUID through the marker.
    expect((await prepareCancellation(f.db, TARGET, identity, CLAIM)).targets[0]?.uuid).toBe(REPLACED)
  })

  test('refuses a replaced table that changed engine or gained dependencies', async () => {
    const f = fake()
    const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    f.state.targetUUID = REPLACED
    f.state.dependencies = '["mv"]'
    await expect(settleCompensation(f.db, TARGET, plan, targetTable(plan.targets), f.lock)).rejects.toThrow('dependencies')
    expect(f.markers.size).toBe(0)
  })

  test('a replace without its marker is adopted only when the stopped run recorded it', async () => {
    const f = fake()
    f.state.targetUUID = REPLACED
    await expect(prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)).rejects.toThrow('identity changed')
    f.state.compensated = true
    const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    expect(plan.targets[0]?.uuid).toBe(REPLACED)
    await markCancellationPending(f.db, TARGET, plan)
    const recovery = await cancelPredecessor(f.db, TARGET, plan, f.lock)
    expect(f.markers.has(`${REPLACE_PREFIX}${ID}`)).toBe(true)
    expect(recovery.obligations[0]?.target.uuid).toBe(REPLACED)
  })

  test('sends one best-effort local KILL per declared member', async () => {
    const f = fake(identity)
    f.state.engine = 'SharedMergeTree'
    f.state.recordedEngine = 'SharedMergeTree'
    const plan = await prepareCancellation(f.db, TARGET, identity, CLAIM)
    await cancelPredecessor(f.db, TARGET, plan, f.lock)
    const kills = f.calls.filter((call) => call.sql.startsWith('KILL'))
    expect(kills).toHaveLength(2)
    expect(kills[0]?.sql).not.toContain('ON CLUSTER')
    expect(kills[0]?.sql).toContain("user = 'writer'")
  })
})

describe('durable inherited recovery handoff', () => {
  test('a marker with a lost ACK blocks ordinary apply and redirects old to zero-own-intent successor', async () => {
    const f = fake()
    const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    await markCancellationPending(f.db, TARGET, plan)
    f.state.failRequired = 'after'
    await expect(cancelPredecessor(f.db, TARGET, plan, f.lock)).rejects.toThrow('ACK lost')
    expect(f.markers.has(`${CANCELLATION_PREFIX}${CLAIM}/completed`)).toBe(false)
    await expect(assertCancellationClear(f.db, TARGET)).rejects.toThrow(SUCCESSOR)
    await expect(prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)).rejects.toThrow(SUCCESSOR)
    f.state.failRequired = ''
    const inherited = await prepareCancellation(f.db, TARGET, IDENTITY, SUCCESSOR)
    expect(inherited.inherited).toBe(true)
    expect(inherited.obligations).toEqual(plan.obligations)
    await assertCancellationClear(f.db, TARGET, SUCCESSOR)
    await markCancellationPending(f.db, TARGET, inherited)
    const killCount = f.calls.filter((call) => call.sql.startsWith('KILL')).length
    const next = await cancelPredecessor(f.db, TARGET, inherited, { ...f.lock, claimId: NEXT })
    expect(f.calls.filter((call) => call.sql.startsWith('KILL'))).toHaveLength(killCount)
    expect(next.parents).toEqual([CLAIM, SUCCESSOR].sort())
    await expect(assertCancellationClear(f.db, TARGET)).rejects.toThrow(NEXT)
    f.state.journalCompleted = true
    await finishRecovery(f.db, TARGET, next, f.lock)
    await assertCancellationClear(f.db, TARGET)
  })

  test('an absent successor marker keeps the original pending cancellation resumable', async () => {
    const f = fake()
    const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    await markCancellationPending(f.db, TARGET, plan)
    f.state.failRequired = 'before'
    await expect(cancelPredecessor(f.db, TARGET, plan, f.lock)).rejects.toThrow('required absent')
    expect(f.markers.has(`${RECOVERY_PREFIX}${SUCCESSOR}/required`)).toBe(false)
    await expect(assertCancellationClear(f.db, TARGET)).rejects.toThrow(CLAIM)
    expect((await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)).claim).toBe(CLAIM)
  })

  test('transferred barrier survives parent completion ACK loss', async () => {
    const f = fake()
    const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    await markCancellationPending(f.db, TARGET, plan)
    await cancelPredecessor(f.db, TARGET, plan, f.lock)
    const inherited = await prepareCancellation(f.db, TARGET, IDENTITY, SUCCESSOR)
    await markCancellationPending(f.db, TARGET, inherited)
    f.state.failRecoveryCompletion = 'after'
    await expect(cancelPredecessor(f.db, TARGET, inherited, { ...f.lock, claimId: NEXT })).rejects.toThrow('ACK lost')
    await expect(assertCancellationClear(f.db, TARGET)).rejects.toThrow(NEXT)
    await expect(prepareCancellation(f.db, TARGET, IDENTITY, SUCCESSOR)).rejects.toThrow(NEXT)
    expect((await prepareCancellation(f.db, TARGET, IDENTITY, NEXT)).inherited).toBe(true)
  })

  test('linked reservation-only crashes are reclaimable before initial or inherited pending writes', async () => {
    const f = fake()
    const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    await assertCancellationUnfinished(f.db, TARGET, plan, [{ claim: NEXT, holder: JSON.stringify({ recoveryOf: CLAIM, queries: IDENTITY }) }])
    await expect(assertCancellationUnfinished(f.db, TARGET, plan, [{ claim: NEXT, holder: JSON.stringify({ recoveryOf: SUCCESSOR, queries: IDENTITY }) }])).rejects.toThrow('linked')
    await markCancellationPending(f.db, TARGET, plan)
    await cancelPredecessor(f.db, TARGET, plan, f.lock)
    const inherited = await prepareCancellation(f.db, TARGET, IDENTITY, SUCCESSOR)
    await assertCancellationUnfinished(f.db, TARGET, inherited, [{ claim: NEXT, holder: JSON.stringify({ recoveryOf: SUCCESSOR, queries: IDENTITY }) }])
  })

  test('preflights a complete two-target recovery and refuses unsupported tails before mutation', async () => {
    const f = fake()
    const initial = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    const contexts = [
      { migration: 'load.sql', statementIndex: 0, forwardSQL: 'INSERT INTO app.events SELECT 1', beforeRetry: 'CREATE OR REPLACE TABLE app.events AS app.events' },
      { migration: 'load.sql', statementIndex: 1, forwardSQL: 'INSERT INTO app.metrics SELECT 2', beforeRetry: 'CREATE OR REPLACE TABLE app.metrics AS app.metrics' },
    ]
    const full = await expandRecoveryPlan(f.db, TARGET, initial, contexts)
    expect(full.obligations).toHaveLength(2)
    expect(full.targets.map((item) => item.name)).toEqual(['events', 'metrics'])
    await expect(expandRecoveryPlan(f.db, TARGET, initial, [...contexts, { ...contexts[0], migration: 'load.sql', statementIndex: 2, forwardSQL: 'ALTER TABLE app.events ADD COLUMN x UInt8', beforeRetry: null }])).rejects.toThrow('throughout')
    expect(f.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
    await expect(expandRecoveryPlan(f.db, TARGET, initial, [])).rejects.toThrow('include it in apply')
    f.state.journalCompleted = true
    expect((await expandRecoveryPlan(f.db, TARGET, initial, [])).obligations).toEqual(initial.obligations)
  })
  test('rejects repeated compensation targets and sources mutated by another obligation', async () => {
    const f = fake()
    const initial = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    const contexts = [
      { migration: 'load.sql', statementIndex: 0, forwardSQL: 'INSERT INTO app.events SELECT 1', beforeRetry: 'CREATE OR REPLACE TABLE app.events AS app.events' },
      { migration: 'load.sql', statementIndex: 1, forwardSQL: 'INSERT INTO app.events SELECT 2', beforeRetry: 'CREATE OR REPLACE TABLE app.events AS app.events' },
    ]
    await expect(expandRecoveryPlan(f.db, TARGET, initial, contexts)).rejects.toThrow('compensation target')
    const chain = [
      { ...contexts[0], forwardSQL: 'INSERT INTO app.events SELECT id FROM app.frozen' },
      { ...contexts[1], forwardSQL: 'INSERT INTO app.frozen SELECT 2', beforeRetry: 'CREATE OR REPLACE TABLE app.frozen AS app.frozen' },
    ]
    const withSource = fake()
    withSource.state.source = true
    const sourcePlan = await prepareCancellation(withSource.db, TARGET, IDENTITY, CLAIM)
    // The original intent's forward fingerprint is fixed to SELECT 1; construct
    // the tested full plan directly from its supported statement metadata below.
    await expect(expandRecoveryPlan(withSource.db, TARGET, { ...sourcePlan, obligations: [] }, chain)).rejects.toThrow('frozen source')
    expect(f.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
    expect(withSource.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
  })

  test('never permits the journal as a recovery source or target', async () => {
    const f = fake()
    const initial = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    for (const [forwardSQL, beforeRetry] of [
      ['INSERT INTO app._chkit_migrations SELECT 1', 'CREATE OR REPLACE TABLE app._chkit_migrations AS app._chkit_migrations'],
      ['INSERT INTO app.events SELECT id FROM app._chkit_migrations', 'CREATE OR REPLACE TABLE app.events AS app.events'],
    ]) {
      await expect(expandRecoveryPlan(f.db, TARGET, { ...initial, obligations: [] }, [{ migration: 'load.sql', statementIndex: 0, forwardSQL: forwardSQL ?? '', beforeRetry: beforeRetry ?? null }])).rejects.toThrow('journal')
    }
    expect(f.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
  })

})
