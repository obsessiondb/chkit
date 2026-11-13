import { describe, expect, test } from 'bun:test'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { statementFingerprint } from '@chkit/core'

import { assertCancellationClear, cancelPredecessor, markCancellationPending, prepareCancellation, resolveQueryIdentity, CANCELLATION_PREFIX } from '../../../commands/migrate/cancellation.js'
import type { QueryIdentity, QueryIntent } from '../../../commands/migrate/query-intents.js'
import { QUERY_INTENT_PREFIX } from '../../../commands/migrate/query-intents.js'
import type { MigrateLock } from '../../../commands/migrate/lock.js'

const CLAIM = '00000000-0000-4000-8000-000000000001'
const ID = '00000000-0000-4000-8000-000000000002'
const SERVER = '00000000-0000-4000-8000-000000000003'
const IDENTITY: QueryIdentity = { protocol: 1, principal: 'writer', serverUUIDs: [SERVER], cluster: 'declared' }
const TARGET = { database: 'app', journalTable: '_chkit_migrations', fanout: undefined }

function fake() {
  const markers = new Map<string, string>()
  const calls: Array<{ sql: string; timeout: number }> = []
  const intent: QueryIntent = { ...IDENTITY, claim: CLAIM, queryId: ID, migration: 'load.sql', statementIndex: 0,
    phase: 'forward', kind: 'insert', fingerprint: statementFingerprint('INSERT INTO app.events SELECT 1'), target: { database: 'app', name: 'events' } }
  const state = { kind: 'insert', engine: 'MergeTree', dependencies: '[]', principal: 'writer', server: SERVER,
    localServer: SERVER, localPrincipal: 'writer',
    killFailure: false, failCompletion: false, held: true, killed: false, unreadable: false, legacy: false }
  const db = {
    queryControlCluster: 'declared',
    commandTracked: async () => {},
    async queryControl(sql: string, timeout: number) {
      calls.push({ sql, timeout })
      if (state.unreadable) throw new Error('replica unreadable')
      if (sql.includes('FROM system.clusters')) return [{ host: 'host', port: '9000', shard: '1', replica: '1' }]
      if (sql.includes('system.one')) return [{ server_uuid: state.server, principal: state.principal }]
      if (sql === 'SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal') return [{ server_uuid: state.localServer, principal: state.localPrincipal }]
      if (sql.includes('argMax(tuple(applied_at')) return [{ name: `__chkit_migrate_lock__/${CLAIM}`, holder: JSON.stringify(state.legacy ? {} : { queries: IDENTITY }) }]
      if (sql.startsWith('INSERT INTO')) {
        const match = /SELECT '([^']+)', now64\(3\), '((?:[^'\\]|\\.)*)'/.exec(sql)
        if (!match) throw new Error('unexpected marker INSERT')
        if (state.failCompletion && match[1]?.endsWith('/completed')) throw new Error('completion unavailable')
        markers.set(match[1] ?? '', (match[2] ?? '').replace(/\\(.)/g, '$1'))
        return []
      }
      if (sql.includes('groupUniqArray(checksum)')) {
        if (sql.includes(QUERY_INTENT_PREFIX)) return [{ name: `${QUERY_INTENT_PREFIX}${CLAIM}/${ID}`, variants: JSON.stringify([JSON.stringify({ ...intent, kind: state.kind })]) }]
        return [...markers].filter(([name]) => !sql.includes('name = ') || sql.includes(`name = '${name}'`)).map(([name, checksum]) => ({ name, variants: JSON.stringify([checksum]) }))
      }
      if (sql.includes('system.tables')) return [{ engine: state.engine, dependencies: state.dependencies }]
      if (sql.startsWith('SELECT query_id')) return [{ query_id: ID, initial_query_id: ID, user: 'writer', initial_user: 'writer' }]
      if (sql.startsWith('KILL QUERY')) {
        if (state.killFailure) throw new Error('cancellation deadline expired')
        state.killed = true
        return [{ kill_status: 'finished' }]
      }
      if (sql.startsWith('SELECT count()')) return [{ n: state.killed ? 0 : 1 }]
      throw new Error(`unexpected control SQL: ${sql}`)
    },
  } as unknown as ClickHouseExecutor
  const lock: MigrateLock = { assertHeld() { if (!state.held) throw new Error('lost ownership') }, release: async () => {} }
  return { db, state, calls, markers, lock }
}

describe('explicit predecessor cancellation (#732)', () => {
  test('pending cancellation blocks later ordinary/no-pending owners until terminal proof completes', async () => {
    const f = fake()
    expect(await resolveQueryIdentity(f.db)).toEqual(IDENTITY)
    const plan = await prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)
    await markCancellationPending(f.db, TARGET, plan)
    await expect(assertCancellationClear(f.db, TARGET)).rejects.toThrow('unfinished')
    // Even a failed identity lookup must retain the declared transport cluster.
    expect(f.calls.at(-1)?.sql).toContain("clusterAllReplicas('declared'")
    await assertCancellationClear(f.db, TARGET, CLAIM)
    await cancelPredecessor(f.db, TARGET, plan, f.lock)
    expect(f.state.killed).toBe(true)
    expect(f.markers.has(`${CANCELLATION_PREFIX}${CLAIM}/completed`)).toBe(true)
    await assertCancellationClear(f.db, TARGET)
    await expect(prepareCancellation(f.db, TARGET, IDENTITY, CLAIM)).rejects.toThrow('already completed')
    const killIndex = f.calls.findIndex((call) => call.sql.startsWith('KILL'))
    const completeIndex = f.calls.findIndex((call) => call.sql.startsWith('INSERT') && call.sql.includes('/completed'))
    expect(completeIndex).toBeGreaterThan(killIndex)
    expect(f.calls[completeIndex]?.timeout).toBeLessThanOrEqual(f.calls[killIndex]?.timeout ?? 0)
  })

  for (const failure of ['killFailure', 'failCompletion', 'held'] as const) {
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

  test('refuses multi-node plain MergeTree compensation and malformed claims', async () => {
    const f = fake()
    await expect(prepareCancellation(f.db, TARGET, { ...IDENTITY, serverUUIDs: [SERVER, ID] }, CLAIM)).rejects.toThrow('one declared server')
    await expect(prepareCancellation(f.db, TARGET, IDENTITY, 'unknown')).rejects.toThrow('UUID')
    expect(f.calls).toEqual([])
  })
})
