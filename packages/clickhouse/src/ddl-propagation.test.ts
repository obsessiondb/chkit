import { describe, expect, test } from 'bun:test'

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

/**
 * A target with `replicas` replicas behind one endpoint. Each poll of a system
 * table answers with the next entry of `polls` (the last one repeats);
 * `formatQuerySingleLine` answers from `formatted`, or echoes its input.
 */
function fakeTarget(polls: object[][], options: { replicas?: number; formatted?: Record<string, string> } = {}) {
  const queries: string[] = []
  let poll = 0
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
      return rows as T[]
    },
  } as unknown as ClickHouseExecutor
  const polled = (source: string) => queries.filter((sql) => sql.includes(source) && !sql.includes('system.one'))
  return { db, queries, polled }
}

const KEY = 'table:app.events:column:raw'

describe('waitForDDLPropagation: MODIFY COLUMN waits for the definition it sets', () => {
  test('keeps waiting while a replica still reports the old default expression', async () => {
    const statement = "ALTER TABLE app.events MODIFY COLUMN `raw` String DEFAULT 'new';"
    const { db, polled, queries } = fakeTarget([
      [row('r1', { default_kind: 'DEFAULT', default_expression: "'new'" }), row('r2', { default_kind: 'DEFAULT', default_expression: "'old'" })],
      [row('r1', { default_kind: 'DEFAULT', default_expression: "'new'" }), row('r2', { default_kind: 'DEFAULT', default_expression: "'new'" })],
    ])

    await waitForDDLPropagation(db, 'alter_table_modify_column', KEY, { statement })

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

    await waitForDDLPropagation(db, 'alter_table_modify_column', KEY, { statement })

    expect(polled('system.columns')).toHaveLength(1)
  })

  test('waits until every replica reports the same type', async () => {
    const statement = 'ALTER TABLE app.events MODIFY COLUMN `raw` Decimal(10,2);'
    const { db, polled } = fakeTarget([
      [row('r1', { type: 'Decimal(10, 2)' }), row('r2', { type: 'Decimal(9, 2)' })],
      [row('r1', { type: 'Decimal(10, 2)' }), row('r2', { type: 'Decimal(10, 2)' })],
    ])

    await waitForDDLPropagation(db, 'alter_table_modify_column', KEY, { statement })

    expect(polled('system.columns')).toHaveLength(2)
  })

  test('waits until every replica lists the column', async () => {
    const { db, polled } = fakeTarget([[row('r1')], [row('r1'), row('r2')]])

    await waitForDDLPropagation(db, 'alter_table_modify_column', KEY, {
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
      statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` REMOVE DEFAULT;',
    })
    expect(removed.polled('system.columns')).toHaveLength(2)

    const codec = fakeTarget([
      [row('r1', { compression_codec: 'CODEC(ZSTD(1))' }), row('r2', { compression_codec: 'CODEC(ZSTD(1))' })],
      [row('r1'), row('r2')],
    ])
    await waitForDDLPropagation(codec.db, 'alter_table_modify_column', KEY, {
      statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` REMOVE CODEC;',
    })
    expect(codec.polled('system.columns')).toHaveLength(2)

    const comment = fakeTarget([
      [row('r1', { comment: 'old' }), row('r2', { comment: 'old' })],
      [row('r1', { comment: "it's" }), row('r2', { comment: "it's" })],
    ])
    await waitForDDLPropagation(comment.db, 'alter_table_modify_column', KEY, {
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
        statement: "ALTER TABLE app.events MODIFY COLUMN `raw` String EPHEMERAL 'seed';",
      }),
    ).rejects.toThrow(
      `waitForDDLPropagation: app.events.raw definition not applied on every replica after 21 checks: replica r1 reports default_expression "defaultValueOfTypeName('String')", the statement sets "'seed'"; every replica reports the same, so this is not replication lag: the server accepted the statement without applying it`,
    )
  }, 30_000)

  test('names the replica and field that still differ when replicas disagree', async () => {
    const { db } = fakeTarget([[row('r1', { type: 'UInt64' }), row('r2', { type: 'UInt32' })]])

    await expect(
      waitForDDLPropagation(db, 'alter_table_modify_column', KEY, {
        statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` UInt64;',
      }),
    ).rejects.toThrow('after 21 checks: replica r2 reports type "UInt32", replica r1 reports "UInt64"')
  }, 30_000)
})

describe('waitForDDLPropagation: deadline', () => {
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
        statement: 'ALTER TABLE app.events MODIFY COLUMN `raw` UInt64;',
      }),
    ).rejects.toThrow('app.events.raw definition not applied on every replica after 1 checks: a check did not return within the 30s deadline')
    expect(Date.now() - started).toBeLessThan(35_000)
  }, 40_000)
})

describe('waitForDDLPropagation: other column and index operations', () => {
  test('ADD COLUMN waits for every replica to agree without checking what the statement sets', async () => {
    const { db, polled, queries } = fakeTarget([
      [row('r1', { comment: 'old' }), row('r2')],
      [row('r1'), row('r2')],
    ])

    await waitForDDLPropagation(db, 'alter_table_add_column', KEY, {
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

    await waitForDDLPropagation(db, 'alter_table_rename_column', 'table:app.events:column_rename:a:b:c', { statement })

    const polls = polled('system.columns')
    expect(polls).toHaveLength(3)
    expect(polls[0]).toContain("name IN ('a:b', 'c')")
  })

  test('RENAME COLUMN without the statement splits a key with one colon', async () => {
    const { db, polled } = fakeTarget([[{ replica: 'r1', name: 'y' }, { replica: 'r2', name: 'y' }]])

    await waitForDDLPropagation(db, 'alter_table_rename_column', 'table:app.events:column_rename:x:y')

    expect(polled('system.columns')[0]).toContain("name IN ('x', 'y')")
  })

  test('ADD and DROP INDEX wait for the index on every replica', async () => {
    const added = fakeTarget([[{ replicas: 1 }], [{ replicas: 2 }]])
    await waitForDDLPropagation(added.db, 'alter_table_add_index', 'table:app.events:index:idx')
    const addPolls = added.polled('system.data_skipping_indices')
    expect(addPolls).toHaveLength(2)
    expect(addPolls[0]).toContain("clusterAllReplicas('default', system.data_skipping_indices)")
    expect(addPolls[0]).toContain("name = 'idx'")

    const dropped = fakeTarget([[{ replicas: 1 }], [{ replicas: 0 }]])
    await waitForDDLPropagation(dropped.db, 'alter_table_drop_index', 'table:app.events:index:idx')
    expect(dropped.polled('system.data_skipping_indices')).toHaveLength(2)
  })
})
