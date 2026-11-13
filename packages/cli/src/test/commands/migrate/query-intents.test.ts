import { describe, expect, test } from 'bun:test'
import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { classifyQueryIntent, createQueryTracker, type QueryIdentity } from '../../../commands/migrate/query-intents.js'

const identity: QueryIdentity = { protocol: 1, principal: 'writer', serverUUIDs: ['00000000-0000-4000-8000-000000000001'] }
const context = { migration: 'load.sql', statementIndex: 0, forwardSQL: 'INSERT INTO app.events SELECT 1', beforeRetry: 'TRUNCATE TABLE app.events' }

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
    expect(classifyQueryIntent(context.forwardSQL, 'forward', 'TRUNCATE TABLE other.events').kind).toBe('unsupported')
    expect(classifyQueryIntent('TRUNCATE TABLE app.events SYNC', 'compensation', null).kind).toBe('unsupported')
    expect(classifyQueryIntent('INSERT INTO TABLE app.events SELECT 1', 'forward', 'TRUNCATE TABLE app.TABLE', 'app').kind).toBe('unsupported')
    expect(classifyQueryIntent('INSERT INTO app.events (id) SELECT 1', 'forward', context.beforeRetry).kind).toBe('insert')
  })

  for (const failure of ['none', 'intent', 'ownership'] as const) {
    test(`persists and reads back an intent before admitting SQL (${failure})`, async () => {
      const events: string[] = []
      let checksum = ''
      let held = true
      const db = {
        async command(sql: string) {
          events.push('intent')
          checksum = /, '((?:[^'\\]|\\.)*)', '.*', false, \[\]$/.exec(sql)?.[1]?.replace(/\\(.)/g, '$1') ?? ''
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
      expect(checksum).not.toContain('TRUNCATE TABLE')
    })
  }
})
