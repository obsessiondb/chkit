import { describe, expect, spyOn, test } from 'bun:test'
import type { ClickHouseExecutor, QueryControlOptions } from '@chkit/clickhouse'
import { statementFingerprint } from '@chkit/core'

import { assertCancellationClear, cancelPredecessor, markCancellationPending, prepareCancellation, resolveQueryIdentity, killWithReceipts, settleCompensation, finishRecovery, expandRecoveryPlan, assertCancellationUnfinished, RECOVERY_PREFIX, CANCELLATION_PREFIX } from '../../../commands/migrate/cancellation.js'
import type { QueryIdentity, QueryIntent, QueryTarget } from '../../../commands/migrate/query-intents.js'
import { QUERY_INTENT_PREFIX } from '../../../commands/migrate/query-intents.js'
import type { MigrateLock } from '../../../commands/migrate/lock.js'

const CLAIM = '00000000-0000-4000-8000-000000000001'
const ID = '00000000-0000-4000-8000-000000000002'
const NEXT = '00000000-0000-4000-8000-000000000007'
const SOURCE = '00000000-0000-4000-8000-000000000006'
const SUCCESSOR = '00000000-0000-4000-8000-000000000005'
const SERVER = '00000000-0000-4000-8000-000000000003'
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
  const intents = new Map<string, QueryIntent[]>([[CLAIM, [intent]]])
  const state = { failRequired: '', failRecoveryCompletion: '', journalOperations: [] as unknown[], metricsUUID: SOURCE, journalCompleted: false, recordedEngine: 'MergeTree', capability: 1, capabilityOverrides: [] as number[], capabilityError: false, partialParts: false, parts: 0, partsReads: 0, source: false, sourceUUID: SOURCE, sourceEngine: 'MergeTree', targetUUID: ID, kind: 'insert', engine: 'MergeTree', dependencies: '[]', principal: 'writer', server: SERVER,
    localServer: SERVER, localPrincipal: 'writer',
    loseAfterKill: false, killFailure: false, failCompletion: false, held: true, killed: false, unreadable: false, legacy: false }
  let receiptId = ''
  const db = {
    queryControlCluster: 'declared',
    commandTracked: async () => {},
    async queryControl(sql: string, timeout: number, options?: QueryControlOptions) {
      calls.push({ sql, timeout })
      if (state.unreadable) throw new Error('replica unreadable')
      if (sql.includes('FROM system.clusters')) return [{ host: 'host', port: '9000', shard: '1', replica: '1' }]
      if (sql.includes('sharedMergeTreeTruncateFenceVersion')) { if (state.capabilityError) throw new Error('UNKNOWN_FUNCTION'); return identity.serverUUIDs.map((server_uuid, index) => ({ server_uuid, principal: state.principal, version: state.capabilityOverrides[index] ?? state.capability })) }
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
          return (intents.get(claim) ?? []).map((item) => ({ name: `${QUERY_INTENT_PREFIX}${claim}/${item.queryId}`, variants: JSON.stringify([JSON.stringify(claim === CLAIM ? { ...item, target: { ...item.target, engine: state.recordedEngine }, kind: state.kind, ...(state.source ? { source: { database: 'app', name: 'frozen', uuid: SOURCE, engine: 'MergeTree' } } : {}) } : item)]) }))
        }
        const prefix = /startsWith\(name, '([^']+)'\)/.exec(sql)?.[1]
        return [...markers].filter(([name]) => (!prefix || name.startsWith(prefix)) && (!sql.includes('name = ') || sql.includes(`name = '${name}'`))).map(([name, checksum]) => ({ name, variants: JSON.stringify([checksum]) }))
      }
      if (sql.includes('arrayMap((op, fp)')) return [{ name: 'load.sql', migration_completed: state.journalCompleted ? '1' : '0', operations: JSON.stringify(state.journalOperations.length ? state.journalOperations : [[0, 'completed', intent.forwardFingerprint]]) }]
      if (sql.includes('system.query_log')) return identity.serverUUIDs.map((server_uuid) => ({ server_uuid, principal: 'writer', query_id: receiptId }))
      if (sql.includes('system.tables')) return identity.serverUUIDs.map((server_uuid) => ({ server_uuid, principal: state.principal, uuid: sql.includes("name = 'frozen'") ? state.sourceUUID : sql.includes("name = 'metrics'") ? state.metricsUUID : state.targetUUID, engine: sql.includes("name = 'frozen'") ? state.sourceEngine : state.engine, dependencies: state.dependencies }))
      if (sql.includes('system.parts')) { state.partsReads++; const n = state.parts; state.parts = 0; return (state.partialParts ? identity.serverUUIDs.slice(0, 1) : identity.serverUUIDs).map((server_uuid) => ({ server_uuid, principal: 'writer', n })) }
      if (sql.startsWith('SELECT query_id')) return [{ query_id: ID, initial_query_id: ID, user: 'writer', initial_user: 'writer' }]
      if (sql.startsWith('KILL QUERY')) {
        if (state.killFailure) throw new Error('cancellation deadline expired')
        receiptId = options?.queryId ?? ''
        state.killed = true
        if (state.loseAfterKill) state.held = false
        return [{ kill_status: 'finished' }]
      }
      if (sql.startsWith('SELECT count()')) return [{ n: state.killed ? 0 : 1 }]
      throw new Error(`unexpected control SQL: ${sql}`)
    },
  } as unknown as ClickHouseExecutor
  const lock: MigrateLock = { claimId: SUCCESSOR, assertHeld() { if (!state.held) throw new Error('lost ownership') }, release: async () => {} }
  return { db, state, calls, markers, lock, intents }
}

describe('explicit predecessor cancellation (#732)', () => {
  test('fresh fixed phase budgets accommodate latency without renewing a loop deadline', async () => {
    const f = fake()
    const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    let now = 0
    const clock = spyOn(performance, 'now').mockImplementation(() => now)
    const query = f.db.queryControl!.bind(f.db)
    f.db.queryControl = async (sql, timeout, options) => {
      if (sql.startsWith('SELECT query_id') || sql.startsWith('SELECT count()') ||
        (sql.startsWith('INSERT') && sql.includes('/required'))) now += 20_000
      return query(sql, timeout, options)
    }
    try {
      await cancelPredecessor(f.db, TARGET, plan, f.lock)
      expect(now).toBe(60_000)
      expect(f.calls.find((call) => call.sql.startsWith('KILL'))?.timeout).toBe(30_000)
      expect(f.calls.find((call) => call.sql.startsWith('INSERT') && call.sql.includes('/required'))?.timeout).toBe(30_000)
      expect(f.markers.has(`${CANCELLATION_PREFIX}${CLAIM}/completed`)).toBe(true)
    } finally { clock.mockRestore() }
  })

  test('repeated receipt polling cannot renew the cancellation phase budget', async () => {
    const f = fake()
    const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    let now = 0
    let reads = 0
    const clock = spyOn(performance, 'now').mockImplementation(() => now)
    const query = f.db.queryControl!.bind(f.db)
    f.db.queryControl = async (sql, timeout, options) => {
      const rows = await query(sql, timeout, options)
      if (sql.includes('system.query_log')) { now += 10_000; reads++; return [] }
      return rows
    }
    try {
      await expect(cancelPredecessor(f.db, TARGET, plan, f.lock)).rejects.toThrow('deadline expired')
      expect(reads).toBe(3)
      expect(f.calls.some((call) => call.sql.startsWith('SELECT count()'))).toBe(false)
      expect(f.markers.size).toBe(0)
    } finally { clock.mockRestore() }
  })

  for (const phase of ['preflight', 'cancellation', 'handoff'] as const) {
    test(`expired ${phase} phase cannot advance to later recovery actions`, async () => {
      const f = fake()
      const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
      let now = 0
      const clock = spyOn(performance, 'now').mockImplementation(() => now)
      const query = f.db.queryControl!.bind(f.db)
      f.db.queryControl = async (sql, timeout, options) => {
        const expires = phase === 'preflight' ? sql.startsWith('SELECT query_id') :
          phase === 'cancellation' ? sql.startsWith('SELECT count()') :
          sql.startsWith('INSERT') && sql.includes('/required')
        if (expires) now += 30_001
        return query(sql, timeout, options)
      }
      try {
        await expect(cancelPredecessor(f.db, TARGET, plan, f.lock)).rejects.toThrow('deadline expired')
        expect(f.state.killed).toBe(phase !== 'preflight')
        expect(f.markers.has(`${RECOVERY_PREFIX}${SUCCESSOR}/required`)).toBe(phase === 'handoff')
        expect(f.markers.has(`${CANCELLATION_PREFIX}${CLAIM}/completed`)).toBe(false)
      } finally { clock.mockRestore() }
    })
  }

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
    expect(f.calls[completeIndex]?.timeout).toBeLessThanOrEqual(f.calls[killIndex]?.timeout ?? 0)
  })

  for (const failure of ['killFailure', 'failCompletion', 'held', 'loseAfterKill'] as const) {
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

  for (const failure of ['async', 'unsupported', 'SharedMergeTree', 'materialized view', 'legacy', 'principal', 'endpoint', 'endpoint principal', 'unreadable'] as const) {
    test(`refuses before any KILL or takeover (${failure})`, async () => {
      const f = fake()
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

  test('refuses multi-node plain MergeTree compensation and malformed claims', async () => {
    const identity = { ...IDENTITY, serverUUIDs: [SERVER, ID] }
    const f = fake(identity)
    await expect(prepareCancellation(f.db, TARGET, identity, CLAIM)).rejects.toThrow('one declared server')
    await expect(prepareCancellation(f.db, TARGET, IDENTITY, 'unknown')).rejects.toThrow('UUID')
    expect(f.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
  })
})

describe('SharedMergeTree fenced recovery', () => {
  const other = '00000000-0000-4000-8000-000000000004'
  const identity = { ...IDENTITY, serverUUIDs: [SERVER, other] }

  test('admits only every-node protocol 1 and waits for settled parts before returning', async () => {
    const f = fake(identity)
    f.state.engine = 'SharedMergeTree'
    f.state.recordedEngine = 'SharedMergeTree'
    const plan = await prepareCancellation(f.db, TARGET, identity, CLAIM)
    expect(plan.targets[0]).toMatchObject({ uuid: ID, engine: 'SharedMergeTree' })
    await markCancellationPending(f.db, TARGET, plan)
    await cancelPredecessor(f.db, TARGET, plan, f.lock)
    f.state.parts = 8
    await settleCompensation(f.db, plan, targetTable(plan.targets), f.lock)
    expect(f.state.partsReads).toBe(2)
    expect(f.calls.find((call) => call.sql.includes('system.parts'))?.sql).toContain('view(SELECT')
  })

  test('refuses disabled or unknown backend capability before any KILL', async () => {
    const f = fake(identity)
    f.state.engine = 'SharedMergeTree'
    f.state.recordedEngine = 'SharedMergeTree'
    f.state.capability = 0
    await expect(prepareCancellation(f.db, TARGET, identity, CLAIM)).rejects.toThrow('protocol 1')
    expect(f.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
  })

  for (const fault of ['mixed versions', 'unknown function', 'partial parts'] as const) {
    test(`fails closed on incomplete backend or storage proof (${fault})`, async () => {
      const f = fake(identity)
      f.state.engine = 'SharedMergeTree'
      f.state.recordedEngine = 'SharedMergeTree'
      if (fault === 'mixed versions') f.state.capabilityOverrides = [1, 0]
      if (fault === 'unknown function') f.state.capabilityError = true
      if (fault !== 'partial parts') {
        await expect(prepareCancellation(f.db, TARGET, identity, CLAIM)).rejects.toThrow()
        expect(f.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
      } else {
        const plan = await prepareCancellation(f.db, TARGET, identity, CLAIM)
        f.state.partialParts = true
        await expect(settleCompensation(f.db, plan, targetTable(plan.targets), f.lock)).rejects.toThrow('every server')
      }
    })
  }

  test('refuses policy disabled after preflight before replacement work', async () => {
    const f = fake(identity)
    f.state.engine = 'SharedMergeTree'
    f.state.recordedEngine = 'SharedMergeTree'
    const plan = await prepareCancellation(f.db, TARGET, identity, CLAIM)
    f.state.capability = 0
    await expect(settleCompensation(f.db, plan, targetTable(plan.targets), f.lock)).rejects.toThrow('protocol 1')
    expect(f.state.partsReads).toBe(0)
  })
})

describe('physical KILL receipt coverage', () => {
  const other = '00000000-0000-4000-8000-000000000004'
  const identity = { ...IDENTITY, serverUUIDs: [SERVER, other] }

  test('requires a finished receipt from every declared member, using fresh physical ids', async () => {
    const physical: string[] = []
    let reads = 0
    const conn = {
      remaining: () => 5000,
      async query<T>(sql: string, options?: QueryControlOptions): Promise<T[]> {
        let rows: unknown[] = []
        if (sql.includes('system.one')) rows = identity.serverUUIDs.map((server_uuid) => ({ server_uuid, principal: 'writer' }))
        else if (sql === 'SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal') rows = [{ server_uuid: SERVER, principal: 'writer' }]
        else if (sql.startsWith('KILL QUERY')) {
          expect(sql).not.toContain('ON CLUSTER')
          expect(sql).toContain("user = 'writer'")
          expect(options?.settings).toMatchObject({ log_queries: 1, log_queries_probability: 1, log_queries_min_query_duration_ms: 0 })
          physical.push(options?.queryId ?? '')
        } else if (sql.includes('system.query_log')) {
          expect(sql).toContain("type = 'QueryFinish' AND exception_code = 0")
          expect(sql).toContain('skip_unavailable_shards = 0')
          expect(sql).toContain('view(SELECT')
          reads++
          rows = [{ server_uuid: SERVER, principal: 'writer', query_id: physical[0] }]
          if (reads > 1) rows.push({ server_uuid: other, principal: 'writer', query_id: physical[1] })
        } else throw new Error(`unexpected SQL ${sql}`)
        return rows as T[]
      },
    }
    await killWithReceipts(conn, identity, [ID])
    expect(physical).toHaveLength(4)
    expect(new Set(physical).size).toBe(4)
    expect(reads).toBe(2)
  })

  for (const replicas of [2, 3]) test(`${replicas}-node round robin cannot pin KILLs to a subset of members`, async () => {
    const identity = { ...IDENTITY, serverUUIDs: [SERVER, other, '00000000-0000-4000-8000-000000000008'].slice(0, replicas) }
    let requests = 0
    let waits = 0
    const receipts: Array<{ server_uuid: string; principal: string; query_id: string }> = []
    const killed = new Set<string>()
    const conn = {
      remaining() { if (++waits > 3) throw new Error('bounded regression deadline'); return 1 },
      async query<T>(sql: string, options?: QueryControlOptions): Promise<T[]> {
        const server = identity.serverUUIDs[requests++ % identity.serverUUIDs.length]
        if (!server) throw new Error('missing route')
        let rows: unknown[] = []
        if (sql.includes('system.one')) rows = identity.serverUUIDs.map((server_uuid) => ({ server_uuid, principal: 'writer' }))
        else if (sql === 'SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal') rows = [{ server_uuid: server, principal: 'writer' }]
        else if (sql.startsWith('KILL QUERY')) {
          killed.add(server)
          receipts.push({ server_uuid: server, principal: 'writer', query_id: options?.queryId ?? '' })
        } else if (sql.includes('system.query_log')) rows = [...receipts]
        else throw new Error(`unexpected SQL ${sql}`)
        return rows as T[]
      },
    }
    await killWithReceipts(conn, identity, [ID])
    expect([...killed].sort()).toEqual([...identity.serverUUIDs].sort())
    expect(new Set(receipts.map((row) => row.query_id)).size).toBe(receipts.length)
  })

  for (const invalid of ['missing member', 'wrong principal', 'wrong server', 'wrong id', 'unreadable logs'] as const) {
    test(`refuses incomplete or invalid receipt coverage (${invalid})`, async () => {
      let remaining = 3
      let physical = ''
      const conn = {
        remaining() { if (--remaining <= 0) throw new Error('deadline'); return 1 },
        async query<T>(sql: string, options?: QueryControlOptions): Promise<T[]> {
          let rows: unknown[] = []
          if (sql.includes('system.one')) rows = identity.serverUUIDs.map((server_uuid) => ({ server_uuid, principal: 'writer' }))
          else if (sql === 'SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal') rows = [{ server_uuid: SERVER, principal: 'writer' }]
          else if (sql.startsWith('KILL QUERY')) physical = options?.queryId ?? ''
          else if (sql.includes('system.query_log')) {
            if (invalid === 'unreadable logs') throw new Error('ACCESS_DENIED')
            rows = [{ server_uuid: invalid === 'wrong server' ? ID : SERVER, principal: invalid === 'wrong principal' ? 'other' : 'writer', query_id: invalid === 'wrong id' ? ID : physical }]
          } else throw new Error(`unexpected SQL ${sql}`)
          return rows as T[]
        },
      }
      await expect(killWithReceipts(conn, identity, [ID])).rejects.toThrow()
    })
  }
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
      { migration: 'load.sql', statementIndex: 0, forwardSQL: 'INSERT INTO app.events SELECT 1', beforeRetry: 'TRUNCATE TABLE app.events' },
      { migration: 'load.sql', statementIndex: 1, forwardSQL: 'INSERT INTO app.metrics SELECT 2', beforeRetry: 'TRUNCATE TABLE app.metrics' },
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
      { migration: 'load.sql', statementIndex: 0, forwardSQL: 'INSERT INTO app.events SELECT 1', beforeRetry: 'TRUNCATE TABLE app.events' },
      { migration: 'load.sql', statementIndex: 1, forwardSQL: 'INSERT INTO app.events SELECT 2', beforeRetry: 'TRUNCATE TABLE app.events' },
    ]
    await expect(expandRecoveryPlan(f.db, TARGET, initial, contexts)).rejects.toThrow('compensation target')
    const chain = [
      { ...contexts[0], forwardSQL: 'INSERT INTO app.events SELECT id FROM app.frozen' },
      { ...contexts[1], forwardSQL: 'INSERT INTO app.frozen SELECT 2', beforeRetry: 'TRUNCATE TABLE app.frozen' },
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
      ['INSERT INTO app._chkit_migrations SELECT 1', 'TRUNCATE TABLE app._chkit_migrations'],
      ['INSERT INTO app.events SELECT id FROM app._chkit_migrations', 'TRUNCATE TABLE app.events'],
    ]) {
      await expect(expandRecoveryPlan(f.db, TARGET, { ...initial, obligations: [] }, [{ migration: 'load.sql', statementIndex: 0, forwardSQL: forwardSQL ?? '', beforeRetry: beforeRetry ?? null }])).rejects.toThrow('journal')
    }
    expect(f.calls.some((call) => call.sql.startsWith('KILL') || call.sql.startsWith('INSERT'))).toBe(false)
  })

})
