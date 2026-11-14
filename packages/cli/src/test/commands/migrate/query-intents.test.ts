import { describe, expect, test } from 'bun:test'
import type { ClickHouseExecutor } from '@chkit/clickhouse'
import { statementFingerprint } from '@chkit/core'

import { classifyQueryIntent, createQueryTracker, type QueryIdentity } from '../../../commands/migrate/query-intents.js'

const identity: QueryIdentity = { protocol: 1, principal: 'writer', serverUUIDs: ['00000000-0000-4000-8000-000000000001'] }
const context = { migration: 'load.sql', statementIndex: 0, forwardSQL: 'INSERT INTO app.events SELECT 1', beforeRetry: 'CREATE OR REPLACE TABLE app.events AS app.events' }

describe('migration query intents (#732)', () => {
  test('classifies executable SQL, not comments or marker claims', () => {
    expect(classifyQueryIntent(context.forwardSQL, 'forward', context.beforeRetry)).toEqual({ kind: 'insert', target: { database: 'app', name: 'events' } })
    expect(classifyQueryIntent('/* INSERT INTO wrong.x */ INSERT INTO `app`.`events` SELECT 1', 'forward', context.beforeRetry).kind).toBe('insert')
    for (const sql of [
      'INSERT INTO app.events SELECT 1 PARALLEL WITH INSERT INTO other.x SELECT 1',
      'INSERT INTO FUNCTION remote(\'host\', app.events) SELECT 1',
      'INSERT INTO app.events SELECT 1 SETTINGS async_insert=1',
      'ALTER TABLE app.events DELETE WHERE 1',
      'INSERT INTO app.events SELECT 1; INSERT INTO other.x SELECT 1',
      'INSERT INTO app.events SELECT 1 FROM numbers(1), app.distributed_source',
      'INSERT INTO app.events SELECT 1 WHERE 1 IN app.distributed_source',
      'INSERT INTO app.events SELECT 1 SETTINGS `async_insert`=1',
    ]) expect(classifyQueryIntent(sql, 'forward', context.beforeRetry).kind).toBe('unsupported')
    expect(classifyQueryIntent(context.forwardSQL, 'forward', 'CREATE OR REPLACE TABLE other.events AS other.events').kind).toBe('unsupported')
    expect(classifyQueryIntent(context.forwardSQL, 'forward', 'TRUNCATE TABLE app.events').kind).toBe('unsupported')
    expect(classifyQueryIntent('CREATE OR REPLACE TABLE events AS events', 'compensation', null, 'app')).toEqual({ kind: 'replace', target: { database: 'app', name: 'events' } })
    for (const sql of ['TRUNCATE TABLE app.events', 'CREATE OR REPLACE TABLE app.events AS app.other', 'CREATE OR REPLACE TABLE app.events AS SELECT * FROM app.events', 'CREATE OR REPLACE TABLE app.events AS app.events ENGINE = Memory', 'CREATE TABLE app.events AS app.events']) {
      expect(classifyQueryIntent(sql, 'compensation', null).kind).toBe('unsupported')
    }
    expect(classifyQueryIntent('INSERT INTO TABLE app.events SELECT 1', 'forward', 'CREATE OR REPLACE TABLE app.TABLE AS app.TABLE', 'app').kind).toBe('unsupported')
    expect(classifyQueryIntent('INSERT INTO app.events (id) SELECT 1', 'forward', context.beforeRetry).kind).toBe('insert')
  })

  test('records one real table source, while refusing hidden secondary sources', () => {
    expect(classifyQueryIntent('INSERT INTO app.events SELECT id, toString(id) FROM app.frozen WHERE id > 0', 'forward', context.beforeRetry)).toEqual({ kind: 'insert', target: { database: 'app', name: 'events' }, source: { database: 'app', name: 'frozen' } })
    for (const sql of [
      'INSERT INTO app.events SELECT id FROM app.events',
      'INSERT INTO app.events SELECT id FROM app.frozen, other.distributed',
      'INSERT INTO app.events SELECT id FROM app.frozen JOIN other.x USING id',
      'INSERT INTO app.events SELECT (SELECT id FROM app.frozen)',
      'INSERT INTO app.events SELECT id FROM app.frozen WHERE id IN other.view',
      'INSERT INTO app.events SELECT id FROM app.frozen UNION ALL SELECT id FROM app.other',
      'INSERT INTO app.events SELECT id FROM remote(\'host\', app.frozen)',
    ]) expect(classifyQueryIntent(sql, 'forward', context.beforeRetry).kind).toBe('unsupported')
  })

  for (const failure of ['none', 'intent', 'ownership'] as const) {
    test(`persists and reads back an intent before admitting SQL (${failure})`, async () => {
      const events: string[] = []
      let checksum = ''
      let held = true
      const db = {
        async command(sql: string) {
          events.push('intent')
          checksum = /, '((?:[^'\\]|\\.)*)', '.*', false, \[\] SETTINGS/.exec(sql)?.[1]?.replace(/\\(.)/g, '$1') ?? ''
          if (failure === 'intent') throw new Error('intent failed')
        },
        async query() { events.push('read-back'); if (failure === 'ownership') held = false; return [{ checksum }] },
        async commandTracked(_sql: string, check: () => void, before: () => Promise<string>) {
          check()
          const id = await before()
          expect(id).toMatch(/^[0-9a-f-]{36}$/)
          check()
          events.push('user SQL')
        },
      } as unknown as ClickHouseExecutor
      const tracker = createQueryTracker({ db, target: { database: 'app', journalTable: '_chkit_migrations', fanout: undefined }, identity,
        lock: { claimId: 'claim', assertHeld() { if (!held) throw new Error('lost ownership') }, release: async () => {} },
      })
      const run = tracker.command(context, 'forward', context.forwardSQL)
      if (failure === 'none') { await run; expect(events).toEqual(['intent', 'read-back', 'user SQL']) }
      else { await expect(run).rejects.toThrow(failure === 'intent' ? 'intent failed' : 'lost ownership'); expect(events).not.toContain('user SQL') }
      expect(checksum).not.toContain('INSERT INTO')
      expect(checksum).not.toContain('CREATE OR REPLACE')
    })
  }

  test('an ordinary run whose intent cannot be stored continues untracked behind a durable marker', async () => {
    const writes: string[] = []
    const sent: string[] = []
    const db = {
      async command(sql: string) {
        writes.push(sql)
        if (!sql.includes('__chkit_migrate_query__/claim/untracked')) throw new Error('intent failed')
      },
      async query() { return [] },
      async commandTracked(sql: string, check: () => void, before: () => Promise<string>) { check(); await before(); check(); sent.push(sql) },
    } as unknown as ClickHouseExecutor
    const logs: string[] = []
    const tracker = createQueryTracker({ db, target: { database: 'app', journalTable: '_chkit_migrations', fanout: undefined }, identity,
      lock: { claimId: 'claim', assertHeld() {}, release: async () => {} }, log: (line) => logs.push(line) })
    await tracker.command(context, 'forward', context.forwardSQL)
    await tracker.command({ ...context, statementIndex: 1 }, 'forward', context.forwardSQL)
    expect(sent).toHaveLength(2)
    expect(writes.filter((sql) => sql.includes('/untracked'))).toHaveLength(1)
    expect(writes).toHaveLength(2)
    expect(logs[0]).toContain('continues untracked')
  })

  test('explicit recovery never degrades to untracked', async () => {
    const db = {
      async command() { throw new Error('intent failed') },
      async query() { return [] },
      async commandTracked(_sql: string, check: () => void, before: () => Promise<string>) { check(); await before() },
    } as unknown as ClickHouseExecutor
    const table = { database: 'app', name: 'events', uuid: '00000000-0000-4000-8000-000000000002', engine: 'MergeTree' }
    const tracker = createQueryTracker({ db, target: { database: 'app', journalTable: '_chkit_migrations', fanout: undefined }, identity,
      lock: { claimId: 'claim', assertHeld() {}, release: async () => {} },
      recovery: { targets: [table], async afterCompensation() { return table } } })
    await expect(tracker.command(context, 'forward', context.forwardSQL)).rejects.toThrow()
  })
})

describe('attested table source admission', () => {
  for (const fault of ['none', 'denied', 'distributed', 'missing member', 'ownership', 'parallel read setting', 'compensation source'] as const) {
    test(`stores source and destination identity before SQL (${fault})`, async () => {
      const events: string[] = []
      let held = true
      let checksum = ''
      const targetUUID = '00000000-0000-4000-8000-000000000002'
      const sourceUUID = '00000000-0000-4000-8000-000000000003'
      const db = {
        async queryControl(sql: string) {
          events.push('metadata')
          expect(sql).toContain('view(SELECT')
          if (fault === 'denied') throw new Error('ACCESS_DENIED')
          if (fault === 'ownership') held = false
          const source = sql.includes("name = 'frozen'")
          return fault === 'missing member' ? [] : [{ server_uuid: identity.serverUUIDs[0], principal: 'writer', uuid: source ? sourceUUID : targetUUID, engine: fault === 'distributed' && source ? 'Distributed' : 'MergeTree', dependencies: '[]' }]
        },
        async command(sql: string) {
          events.push('intent')
          expect(sql).toContain("insert_quorum = 'auto'")
          checksum = /, '((?:[^'\\]|\\.)*)', '.*', false, \[\] SETTINGS/.exec(sql)?.[1]?.replace(/\\(.)/g, '$1') ?? ''
        },
        async query(sql: string) { events.push('read-back'); expect(sql).toContain("clusterAllReplicas('declared'"); return [{ checksum }] },
        async commandTracked(_sql: string, check: () => void, before: () => Promise<string>) { check(); await before(); check(); events.push('user SQL') },
      } as unknown as ClickHouseExecutor
      const tracker = createQueryTracker({ db, identity: { ...identity, cluster: 'declared' }, target: { database: 'app', journalTable: '_chkit_migrations', fanout: undefined }, lock: { claimId: 'claim', assertHeld() { if (!held) throw new Error('ownership lost') }, release: async () => {} } })
      const sql = 'INSERT INTO app.events SELECT id FROM app.frozen'
      const run = tracker.command({ ...context, forwardSQL: sql }, fault === 'compensation source' ? 'compensation' : 'forward', fault === 'compensation source' ? context.beforeRetry : sql, fault === 'parallel read setting' ? { cluster_for_parallel_replicas: 'other' } : { max_threads: 1 })
      if (fault === 'ownership') {
        await expect(run).rejects.toThrow('ownership lost')
        expect(events).not.toContain('user SQL')
      } else {
        await run
        const intent = JSON.parse(checksum)
        expect(intent.kind).toBe(fault === 'compensation source' ? 'replace' : fault === 'none' ? 'insert' : 'unsupported')
        expect(intent.forwardFingerprint).toBe(statementFingerprint(sql))
        if (fault === 'compensation source') expect(intent.fingerprint).toBe(statementFingerprint(context.beforeRetry))
        expect(events.at(-1)).toBe('user SQL')
        if (fault === 'none' || fault === 'compensation source') {
          expect(intent.target).toMatchObject({ uuid: targetUUID, engine: 'MergeTree' })
          expect(intent.source).toMatchObject({ uuid: sourceUUID, engine: 'MergeTree' })
          expect(events).toEqual(['metadata', 'metadata', 'intent', 'read-back', 'user SQL'])
        }
      }
    })
  }
})

describe('strict explicit recovery tracker', () => {
  for (const fault of ['none', 'unsupported SQL', 'changed UUID', 'metadata denied', 'settlement failure', 'lost after SQL', 'source changed'] as const) {
    test(`checks current SQL before admission and settles before the next INSERT (${fault})`, async () => {
      const events: string[] = []
      let held = true
      let checksum = ''
      const uuid = '00000000-0000-4000-8000-000000000002'
      const table = { database: 'app', name: 'events', uuid, engine: 'SharedMergeTree' }
      const db = {
        async queryControl(sql: string) {
          events.push('metadata')
          if (fault === 'metadata denied') throw new Error('ACCESS_DENIED')
          return [{ server_uuid: identity.serverUUIDs[0], principal: 'writer', uuid: sql.includes("name = 'frozen'") ? '00000000-0000-4000-8000-000000000004' : fault === 'changed UUID' ? identity.serverUUIDs[0] : uuid, engine: 'SharedMergeTree', dependencies: '[]' }]
        },
        async command(sql: string) {
          events.push('intent')
          checksum = /, '((?:[^'\\]|\\.)*)', '.*', false, \[\] SETTINGS/.exec(sql)?.[1]?.replace(/\\(.)/g, '$1') ?? ''
        },
        async query() { events.push('read-back'); return [{ checksum }] },
        async commandTracked(sql: string, check: () => void, before: () => Promise<string>, settings?: Record<string, unknown>) {
          check(); await before(); check()
          const compensation = sql.startsWith('CREATE OR REPLACE')
          expect(settings).toBeUndefined()
          events.push(compensation ? 'compensation' : 'forward')
          if (fault === 'lost after SQL') held = false
        },
      } as unknown as ClickHouseExecutor
      const tracker = createQueryTracker({ db, identity: { ...identity, cluster: 'declared' }, target: { database: 'app', journalTable: '_chkit_migrations', fanout: undefined },
        lock: { claimId: 'claim', assertHeld() { if (!held) throw new Error('ownership lost') }, release: async () => {} },
        recovery: { targets: [table], sources: [{ database: 'app', name: 'frozen', uuid: '00000000-0000-4000-8000-000000000003', engine: 'SharedMergeTree' }], async afterCompensation(actual) { expect(actual).toEqual(table); events.push('settled'); if (fault === 'settlement failure') throw new Error('not settled'); return table } },
      })
      const actualContext = fault === 'source changed' ? { ...context, forwardSQL: 'INSERT INTO app.events SELECT id FROM app.frozen' } : context
      const compensation = fault === 'unsupported SQL' ? 'TRUNCATE TABLE app.events' : context.beforeRetry
      const run = (async () => {
        await tracker.command(actualContext, 'compensation', compensation)
        await tracker.command(actualContext, 'forward', actualContext.forwardSQL)
      })()
      if (fault === 'none') {
        await run
        expect(events).toEqual(['metadata', 'intent', 'read-back', 'compensation', 'settled', 'metadata', 'intent', 'read-back', 'forward'])
      } else {
        await expect(run).rejects.toThrow()
        expect(events).not.toContain('forward')
        if (['unsupported SQL', 'changed UUID', 'metadata denied'].includes(fault)) {
          expect(events).not.toContain('intent')
          expect(events).not.toContain('compensation')
        }
      }
    })
  }
})
