import { afterEach, describe, expect, type Mock, setSystemTime, spyOn, test } from 'bun:test'

import { waitForDDLPropagation } from './ddl-propagation.js'
import type { ClickHouseExecutor } from './index.js'

interface ColumnRow {
  replica: string
  type: string
  default_kind: string
  default_expression: string
  comment: string
  compression_codec: string
}

const BASE: Omit<ColumnRow, 'replica'> = {
  type: 'String',
  default_kind: '',
  default_expression: '',
  comment: '',
  compression_codec: '',
}

function row(replica: string, fields: Partial<ColumnRow> = {}): ColumnRow {
  return { replica, ...BASE, ...fields }
}

// The fakes freeze the monotonic clock the waits time their deadline on and
// let each check take 500 ms, the default poll interval, so a wait gives up
// after 60 checks, 30 s (#719).
const CHECK_MS = 500
let now = 0
let clock: Mock<() => number> | undefined

function freezeClock(): void {
  now = 0
  clock = spyOn(performance, 'now').mockImplementation(() => now)
}

function tick(): void {
  now += CHECK_MS
}

afterEach(() => {
  clock?.mockRestore()
  clock = undefined
  setSystemTime()
})

/**
 * A target with `replicas` replicas behind one endpoint. Each poll of a system
 * table answers with the next entry of `polls` (the last one repeats) and
 * takes 500 ms; `formatQuerySingleLine` answers from `formatted`, or echoes its input.
 */
function fakeTarget(polls: object[][], options: { replicas?: number; formatted?: Record<string, string> } = {}) {
  const queries: string[] = []
  let poll = 0
  freezeClock()
  const db = {
    async query<T>(sql: string): Promise<T[]> {
      queries.push(sql)
      if (sql.includes('system.one')) return [{ replicas: options.replicas ?? 2 }] as T[]
      const format = sql.match(/^SELECT formatQuerySingleLine\('SELECT (.*)'\) AS formatted$/)
      if (format) {
        const input = (format[1] ?? '').replace(/\\(.)/g, '$1')
        return [{ formatted: `SELECT ${options.formatted?.[input] ?? input}` }] as T[]
      }
      const rows = polls[Math.min(poll, polls.length - 1)] ?? []
      poll += 1
      tick()
      return rows as T[]
    },
  } as unknown as ClickHouseExecutor
  const polled = (source: string) => queries.filter((sql) => sql.includes(source) && !sql.includes('system.one'))
  return { db, queries, polled }
}

const KEY = 'table:app.events:column:raw'
const FAST = { pollIntervalMs: 1 }

describe('waitForDDLPropagation: MODIFY COLUMN waits for the definition it sets', () => {
  test('keeps waiting while a replica still reports the old default expression', async () => {
    const statement = "ALTER TABLE app.events MODIFY COLUMN `raw` String DEFAULT 'new';"
    const { db, polled, queries } = fakeTarget([
      [row('r1', { default_kind: 'DEFAULT', default_expression: "'new'" }), row('r2', { default_kind: 'DEFAULT', default_expression: "'old'" })],
      [row('r1', { default_kind: 'DEFAULT', default_expression: "'new'" }), row('r2', { default_kind: 'DEFAULT', default_expression: "'new'" })],
    ])

    await waitForDDLPropagation(db, 'alter_table_modify_column', KEY, { ...FAST, statement })

    const polls = polled('system.columns')
    expect(polls).toHaveLength(2)
    expect(polls[0]).toContain("clusterAllReplicas('default', system.columns)")
    expect(polls[0]).toContain("name = 'raw'")
    expect(queries.filter((sql) => sql.includes('formatQuerySingleLine'))).toEqual([
      "SELECT formatQuerySingleLine('SELECT \\'new\\'') AS formatted",
    ])
  })

  test('compares the default expression as the server formats it', async () => {
    const statement = 'ALTER TABLE app.events MODIFY COLUMN `raw` UInt64 MATERIALIZED a+1 || b;'
    const formatted = { 'a+1 || b': 'concat(a + 1, b)' }
    const applied = row('r1', { default_kind: 'MATERIALIZED', default_expression: 'concat(a + 1, b)' })
    const { db, polled } = fakeTarget([[applied, { ...applied, replica: 'r2' }]], { formatted })

    await waitForDDLPropagation(db, 'alter_table_modify_column', KEY, { ...FAST, statement })

    expect(polled('system.columns')).toHaveLength(1)
  })

  test('waits until every replica reports the same type', async () => {
    const statement = 'ALTER TABLE app.events MODIFY COLUMN `raw` Decimal(10,2);'
    const { db, polled } = fakeTarget([
      [row('r1', { type: 'Decimal(10, 2)' }), row('r2', { type: 'Decimal(9, 2)' })],
      [row('r1', { type: 'Decimal(10, 2)' }), row('r2', { type: 'Decimal(10, 2)' })],
    ])

    await waitForDDLPropagation(db, 'alter_table_modify_column', KEY, { ...FAST, statement })

    expect(polled('system.columns')).toHaveLength(2)
  })

  test('waits until every replica lists the column', async () => {
    const { db, polled } = fakeTarget([[row('r1')], [row('r1'), row('r2')]])

    await waitForDDLPropagation(db, 'alter_table_modify_column', KEY, {
      ...FAST,
      statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` String;',
    })

    expect(polled('system.columns')).toHaveLength(2)
  })

  test('waits for REMOVE of a default, a codec and a comment', async () => {
    const removed = fakeTarget([
      [row('r1'), row('r2', { default_kind: 'DEFAULT', default_expression: "'x'" })],
      [row('r1'), row('r2')],
    ])
    await waitForDDLPropagation(removed.db, 'alter_table_modify_column', KEY, {
      ...FAST,
      statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` REMOVE DEFAULT;',
    })
    expect(removed.polled('system.columns')).toHaveLength(2)

    const codec = fakeTarget([
      [row('r1', { compression_codec: 'CODEC(ZSTD(1))' }), row('r2', { compression_codec: 'CODEC(ZSTD(1))' })],
      [row('r1'), row('r2')],
    ])
    await waitForDDLPropagation(codec.db, 'alter_table_modify_column', KEY, {
      ...FAST,
      statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` REMOVE CODEC;',
    })
    expect(codec.polled('system.columns')).toHaveLength(2)

    const comment = fakeTarget([
      [row('r1', { comment: 'old' }), row('r2', { comment: 'old' })],
      [row('r1', { comment: "it's" }), row('r2', { comment: "it's" })],
    ])
    await waitForDDLPropagation(comment.db, 'alter_table_modify_column', KEY, {
      ...FAST,
      statement: "ALTER TABLE app.events MODIFY COLUMN `raw` String COMMENT 'it''s';",
    })
    expect(comment.polled('system.columns')).toHaveLength(2)
  })

  test('waits for a bare EPHEMERAL to store the type default', async () => {
    const { db, polled } = fakeTarget([
      [row('r1', { default_kind: 'EPHEMERAL', default_expression: "'seed'" }), row('r2', { default_kind: 'EPHEMERAL', default_expression: "'seed'" })],
      [
        row('r1', { default_kind: 'EPHEMERAL', default_expression: "defaultValueOfTypeName('String')" }),
        row('r2', { default_kind: 'EPHEMERAL', default_expression: "defaultValueOfTypeName('String')" }),
      ],
    ])

    await waitForDDLPropagation(db, 'alter_table_modify_column', KEY, {
      ...FAST,
      statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` String EPHEMERAL;',
    })

    expect(polled('system.columns')).toHaveLength(2)
  })

  test('checks the definition on a single-replica target too', async () => {
    const { db, polled } = fakeTarget(
      [[row('h', { default_kind: 'DEFAULT', default_expression: "'old'" })], [row('h', { default_kind: 'DEFAULT', default_expression: "'new'" })]],
      { replicas: 1 },
    )

    await waitForDDLPropagation(db, 'alter_table_modify_column', KEY, {
      ...FAST,
      statement: "ALTER TABLE app.events MODIFY COLUMN `raw` String DEFAULT 'new';",
    })

    const polls = polled('system.columns')
    expect(polls).toHaveLength(2)
    expect(polls[0]).not.toContain('clusterAllReplicas')
  })

  test('names the field and says it is not lag when every replica kept the old definition (#285)', async () => {
    const kept = { default_kind: 'EPHEMERAL', default_expression: "defaultValueOfTypeName('String')" }
    const { db } = fakeTarget([[row('r1', kept), row('r2', kept)]])

    await expect(
      waitForDDLPropagation(db, 'alter_table_modify_column', KEY, {
        ...FAST,
        statement: "ALTER TABLE app.events MODIFY COLUMN `raw` String EPHEMERAL 'seed';",
      }),
    ).rejects.toThrow(
      `waitForDDLPropagation: app.events.raw definition not applied on every replica after 60 checks: replica r1 reports default_expression "defaultValueOfTypeName('String')", the statement sets "'seed'"; every replica reports the same, so this is not replication lag: the server accepted the statement without applying it`,
    )
  })

  test('names the replica and field that still differ when replicas disagree', async () => {
    const { db } = fakeTarget([[row('r1', { type: 'UInt64' }), row('r2', { type: 'UInt32' })]])

    await expect(
      waitForDDLPropagation(db, 'alter_table_modify_column', KEY, {
        ...FAST,
        statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` UInt64;',
      }),
    ).rejects.toThrow('after 60 checks: replica r2 reports type "UInt32", replica r1 reports "UInt64"')
  })
})

describe('waitForDDLPropagation: deadline', () => {
  test('a wait ends at its deadline while the wall clock stands still', async () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const db = {
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('system.one')) return [{ replicas: 2 }] as T[]
        return [] as T[]
      },
    } as unknown as ClickHouseExecutor
    const options = { ...FAST, deadlineMs: 50 }

    await expect(waitForDDLPropagation(db, 'create_table', 'table:app.events', options)).rejects.toThrow(
      'waitForTable: app.events not yet visible',
    )
    await expect(
      waitForDDLPropagation(db, 'alter_table_modify_column', KEY, {
        ...options,
        statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` UInt64;',
      }),
    ).rejects.toThrow('app.events.raw definition not applied on every replica')
  })

  test('a polling query that never returns ends the wait at the deadline', async () => {
    const db = {
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('system.one')) return [{ replicas: 2 }] as T[]
        return new Promise<T[]>(() => {})
      },
    } as unknown as ClickHouseExecutor
    const started = Date.now()

    await expect(
      waitForDDLPropagation(db, 'alter_table_modify_column', KEY, {
        ...FAST,
        deadlineMs: 500,
        statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` UInt64;',
      }),
    ).rejects.toThrow('app.events.raw definition not applied on every replica after 1 checks: a check did not return within the 0.5s deadline')
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

// chkit-py's tests/test_ddl_propagation.py pins the same budget (#578, #719).
describe('waitForDDLPropagation: catalog waits poll for 30 s', () => {
  const never = (rows: object[]) => Array.from({ length: 100 }, () => rows)
  // Listed for the first `checks` checks, then not (or the other way round).
  const after = (checks: number, before: object[], then: object[]) => [...Array.from({ length: checks }, () => before), then]

  test('a table that never appears is checked 60 times, 30 s, and fails as before', async () => {
    const { db, polled } = fakeTarget([[]], { replicas: 1 })

    await expect(waitForDDLPropagation(db, 'create_table', 'table:app.events', FAST)).rejects.toThrow(
      'waitForTable: app.events not yet visible',
    )
    expect(polled('system.tables')).toHaveLength(60)
  })

  test('a table that reaches every replica after 15 s passes', async () => {
    const { db, polled } = fakeTarget(after(30, [{ replicas: 1 }], [{ replicas: 2 }]))

    await waitForDDLPropagation(db, 'create_table', 'table:app.events', FAST)
    expect(polled('system.tables')).toHaveLength(31)
  })

  test('a table that appears on the 60th check passes', async () => {
    const { db, polled } = fakeTarget(after(59, [], [{ x: 1 }]), { replicas: 1 })

    await waitForDDLPropagation(db, 'create_table', 'table:app.events', FAST)
    expect(polled('system.tables')).toHaveLength(60)
  })

  test('a dropped table that a replica lists for 20 s passes', async () => {
    const { db, polled } = fakeTarget(after(40, [{ replicas: 1 }], [{ replicas: 0 }]))

    await waitForDDLPropagation(db, 'drop_table', 'table:app.events__cutover_1_reconcile', FAST)
    expect(polled('system.tables')).toHaveLength(41)
  })

  test('a dropped table that a replica keeps listing fails as before after 30 s', async () => {
    const { db, polled } = fakeTarget(never([{ replicas: 1 }]))

    await expect(
      waitForDDLPropagation(db, 'drop_table', 'table:app.events__cutover_1_reconcile', FAST),
    ).rejects.toThrow('waitForTableAbsent: app.events__cutover_1_reconcile still present')
    expect(polled('system.tables')).toHaveLength(60)
  })

  // p-retry gives up at once on a TypeError that is not a fetch network
  // failure; chkit-py's _poll does the same for TypeError and AttributeError (#627).
  function failingTarget(error: () => Error) {
    let checks = 0
    freezeClock()
    const db = {
      async query<T>(sql: string): Promise<T[]> {
        if (sql.includes('system.one')) return [{ replicas: 1 }] as T[]
        checks += 1
        tick()
        throw error()
      },
    } as unknown as ClickHouseExecutor
    return { db, checks: () => checks }
  }

  test('a programming error in the check fails the wait after one check', async () => {
    const { db, checks } = failingTarget(() => new TypeError("Cannot read properties of undefined (reading 'rows')"))

    await expect(waitForDDLPropagation(db, 'create_table', 'table:app.events', FAST)).rejects.toThrow(TypeError)
    expect(checks()).toBe(1)
  })

  test('a server error in the check is retried for 30 s: 60 checks', async () => {
    const { db, checks } = failingTarget(() => new Error('Code: 210. DB::NetException: Connection refused'))

    await expect(waitForDDLPropagation(db, 'create_table', 'table:app.events', FAST)).rejects.toThrow('Connection refused')
    expect(checks()).toBe(60)
  })

  test('a fetch network failure, a TypeError, is retried for 30 s: 60 checks', async () => {
    const { db, checks } = failingTarget(() => new TypeError('fetch failed'))

    await expect(waitForDDLPropagation(db, 'create_table', 'table:app.events', FAST)).rejects.toThrow('fetch failed')
    expect(checks()).toBe(60)
  })

  test('a dictionary that never appears is checked 60 times', async () => {
    const { db, polled } = fakeTarget([[]], { replicas: 1 })

    await expect(waitForDDLPropagation(db, 'create_dictionary', 'dictionary:app.users', FAST)).rejects.toThrow(
      'waitForDictionary: app.users not yet visible',
    )
    expect(polled('system.tables')).toHaveLength(60)
  })

  test('a dictionary that reaches every replica after 15 s passes', async () => {
    const { db, polled } = fakeTarget(after(30, [{ replicas: 1, agreed: 1 }], [{ replicas: 2, agreed: 1 }]))

    await waitForDDLPropagation(db, 'create_dictionary', 'dictionary:app.users', FAST)
    expect(polled('system.tables')).toHaveLength(31)
  })

  test('a column definition that reaches every replica after 15 s passes', async () => {
    const { db, polled } = fakeTarget(after(30, [row('r1', { type: 'UInt64' }), row('r2')], [row('r1', { type: 'UInt64' }), row('r2', { type: 'UInt64' })]))

    await waitForDDLPropagation(db, 'alter_table_modify_column', KEY, {
      ...FAST,
      statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` UInt64;',
    })
    expect(polled('system.columns')).toHaveLength(31)
  })
})

describe('waitForDDLPropagation: other column and index operations', () => {
  test('ADD COLUMN waits for every replica to agree without checking what the statement sets', async () => {
    const { db, polled, queries } = fakeTarget([
      [row('r1', { comment: 'old' }), row('r2')],
      [row('r1'), row('r2')],
    ])

    await waitForDDLPropagation(db, 'alter_table_add_column', KEY, {
      ...FAST,
      statement: "ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `raw` String DEFAULT 'x' COMMENT 'c';",
    })

    expect(polled('system.columns')).toHaveLength(2)
    expect(queries.some((sql) => sql.includes('formatQuerySingleLine'))).toBe(false)
  })

  test('RENAME COLUMN waits until no replica lists the old name and every replica lists the new one', async () => {
    const statement = 'ALTER TABLE app.events RENAME COLUMN IF EXISTS `a:b` TO `c`;'
    const { db, polled } = fakeTarget([
      [{ replica: 'r1', name: 'c' }, { replica: 'r2', name: 'a:b' }],
      [{ replica: 'r1', name: 'c' }],
      [{ replica: 'r1', name: 'c' }, { replica: 'r2', name: 'c' }],
    ])

    await waitForDDLPropagation(db, 'alter_table_rename_column', 'table:app.events:column_rename:a:b:c', { ...FAST, statement })

    const polls = polled('system.columns')
    expect(polls).toHaveLength(3)
    expect(polls[0]).toContain("name IN ('a:b', 'c')")
  })

  test('RENAME COLUMN without the statement splits a key with one colon', async () => {
    const { db, polled } = fakeTarget([[{ replica: 'r1', name: 'y' }, { replica: 'r2', name: 'y' }]])

    await waitForDDLPropagation(db, 'alter_table_rename_column', 'table:app.events:column_rename:x:y', FAST)

    expect(polled('system.columns')[0]).toContain("name IN ('x', 'y')")
  })

  test('ADD and DROP INDEX wait for the index on every replica', async () => {
    const added = fakeTarget([[{ replicas: 1 }], [{ replicas: 2 }]])
    await waitForDDLPropagation(added.db, 'alter_table_add_index', 'table:app.events:index:idx', FAST)
    const addPolls = added.polled('system.data_skipping_indices')
    expect(addPolls).toHaveLength(2)
    expect(addPolls[0]).toContain("clusterAllReplicas('default', system.data_skipping_indices)")
    expect(addPolls[0]).toContain("name = 'idx'")

    const dropped = fakeTarget([[{ replicas: 1 }], [{ replicas: 0 }]])
    await waitForDDLPropagation(dropped.db, 'alter_table_drop_index', 'table:app.events:index:idx', FAST)
    expect(dropped.polled('system.data_skipping_indices')).toHaveLength(2)
  })
})
