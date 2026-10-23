import { describe, expect, test } from 'bun:test'

import { planDiff, quoteIdentifier, renderQualifiedName, table, toCreateSQL, type TableDefinition } from '@chkit/core'

import { waitForDDLPropagation } from './ddl-propagation.js'
import { createLiveExecutor, createPrefix, getLiveEnv } from './e2e-testkit.js'
import type { ClickHouseExecutor } from './index.js'
import { allReplicas, resolveReplicaFanout, stringLiteral } from './replicas.js'

const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'

/**
 * `migrate` waits after each statement until every replica shows what the
 * statement set (#290). These run the planner's statements against the live
 * target, so a column definition ClickHouse formats differently from how chkit
 * wrote it would time out here.
 */
describe('@chkit/clickhouse column definition wait e2e', () => {
  test('planned MODIFY, REMOVE, RENAME and index statements pass the wait on every replica', async () => {
    const env = getLiveEnv()
    const executor = createLiveExecutor(env)
    const name = `${createPrefix('defwait')}t`
    const before = table({
      database: env.clickhouseDatabase,
      name,
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
      columns: [
        { name: 'id', type: 'UInt32' },
        { name: 'raw', type: 'String', defaultKind: 'EPHEMERAL' },
        { name: 's', type: 'String', default: 'abc', comment: 'c1', codec: { kind: 'ZSTD', level: 3 } },
        { name: 'a', type: 'UInt64', default: { expression: 'length(raw)' } },
        { name: 'b', type: 'UInt64', defaultKind: 'MATERIALIZED', default: { expression: 'a+1' } },
        { name: 'c', type: 'String', defaultKind: 'ALIAS', default: { expression: "concat(s,'-',toString(id))" } },
        { name: 'd', type: 'Decimal(10,2)', default: 1.5 },
        { name: 'e', type: 'Array(UInt8)', default: { expression: '[1,2,3]' } },
        { name: 'f', type: 'UInt8', default: { expression: 'if(id>10,1,0)' } },
        { name: 'v', type: 'Date', default: { expression: 'toDate(now()) - INTERVAL 1 DAY' } },
        { name: 'm', type: "DateTime64(3, 'UTC')", default: { expression: 'now64(3)' } },
        { name: 'x', type: 'UInt64', codec: [{ kind: 'Delta' }, { kind: 'ZSTD' }] },
        { name: 'k', type: 'UInt32', defaultKind: 'MATERIALIZED', default: { expression: 'id' } },
        { name: 'old:name', type: 'String' },
      ],
      indexes: [{ name: 'idx', expression: 'a', type: 'minmax', granularity: 1 }],
    })
    const after: TableDefinition = {
      ...before,
      columns: before.columns.map((column) => {
        switch (column.name) {
          case 's':
            return { ...column, default: { expression: "lower(toString(id)) || 'x'" }, comment: "it's" }
          case 'a':
            return { ...column, default: { expression: 'length(raw)*2+1' } }
          case 'b':
            return { ...column, default: { expression: 'a+2' } }
          case 'c':
            return { ...column, default: { expression: "s||'-'||toString(id)" } }
          case 'd':
            return { ...column, type: 'Decimal(12,3)', default: 2.5 }
          case 'e':
            return { ...column, default: { expression: '[4,5]' } }
          case 'f':
            return { ...column, default: { expression: 'id > 10 AND id != 20' } }
          case 'v':
            return { ...column, default: { expression: 'toDate(now()) - INTERVAL 2 DAY' } }
          case 'm':
            return { name: 'm', type: column.type }
          case 'x':
            return { name: 'x', type: 'UInt64' }
          case 'k':
            return { ...column, defaultKind: 'DEFAULT', default: { expression: 'id*2' } }
          default:
            return column
        }
      }),
      indexes: [{ name: 'idx', expression: 'b', type: 'minmax', granularity: 2 }],
    }
    const qualified = renderQualifiedName(env.clickhouseDatabase, name)

    try {
      await executor.command(toCreateSQL(before))
      await waitForDDLPropagation(executor, 'create_table', `table:${env.clickhouseDatabase}.${name}`)
      const operations = planDiff([before], [after]).operations
      expect(operations.map((operation) => operation.type).sort()).toEqual([
        'alter_table_add_index',
        'alter_table_drop_index',
        ...Array(12).fill('alter_table_modify_column'),
      ])
      for (const operation of operations) {
        await executor.command(operation.sql)
        await waitForDDLPropagation(executor, operation.type, operation.key, { statement: operation.sql })
      }
      const rename = `ALTER TABLE ${qualified} RENAME COLUMN IF EXISTS ${quoteIdentifier('old:name')} TO ${quoteIdentifier('new')};`
      await executor.command(rename)
      await waitForDDLPropagation(
        executor,
        'alter_table_rename_column',
        `table:${env.clickhouseDatabase}.${name}:column_rename:old:name:new`,
        { statement: rename },
      )

      const columns = await everyReplica(
        executor,
        'system.columns',
        `name, default_kind, default_expression, comment, compression_codec`,
        `database = ${stringLiteral(env.clickhouseDatabase)} AND table = ${stringLiteral(name)} AND name IN ('s', 'm', 'x', 'k', 'old:name', 'new')`,
      )
      for (const replica of columns) {
        expect(replica).toEqual([
          { name: 'k', default_kind: 'DEFAULT', default_expression: 'id * 2', comment: '', compression_codec: '' },
          { name: 'm', default_kind: '', default_expression: '', comment: '', compression_codec: '' },
          { name: 'new', default_kind: '', default_expression: '', comment: '', compression_codec: '' },
          {
            name: 's',
            default_kind: 'DEFAULT',
            default_expression: "concat(lower(toString(id)), 'x')",
            comment: "it's",
            compression_codec: 'CODEC(ZSTD(3))',
          },
          { name: 'x', default_kind: '', default_expression: '', comment: '', compression_codec: '' },
        ])
      }
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${qualified} SYNC`)
      await executor.close()
    }
  }, 180_000)

  test('a definition the server does not show fails the wait, naming the field', async () => {
    const env = getLiveEnv()
    const executor = createLiveExecutor(env)
    const name = `${createPrefix('defwait_miss')}t`
    const qualified = renderQualifiedName(env.clickhouseDatabase, name)

    try {
      await executor.command(`CREATE TABLE ${qualified} (id UInt32, s String DEFAULT 'old') ENGINE = MergeTree ORDER BY id`)
      await waitForDDLPropagation(executor, 'create_table', `table:${env.clickhouseDatabase}.${name}`)
      // The statement never runs, as if the server accepted it without applying
      // it. A wait that only checks the column is listed would pass.
      await expect(
        waitForDDLPropagation(executor, 'alter_table_modify_column', `table:${env.clickhouseDatabase}.${name}:column:s`, {
          statement: `ALTER TABLE ${qualified} MODIFY COLUMN \`s\` String DEFAULT 'new';`,
        }),
      ).rejects.toThrow(`reports default_expression "'old'", the statement sets "'new'"`)
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${qualified} SYNC`)
      await executor.close()
    }
  }, 60_000)

  // ObsessionDB accepts MODIFY COLUMN ... EPHEMERAL <default> without changing
  // the default (https://github.com/obsessiondb/chkit/issues/285), so there the
  // wait fails as it should. The verify job runs this against ClickHouse.
  test.skipIf(onObsessionDB)('an EPHEMERAL default change passes the wait once every replica stores it', async () => {
    const env = getLiveEnv()
    const executor = createLiveExecutor(env)
    const name = `${createPrefix('defwait_eph')}t`
    const qualified = renderQualifiedName(env.clickhouseDatabase, name)
    const key = `table:${env.clickhouseDatabase}.${name}:column:raw`

    try {
      await executor.command(`CREATE TABLE ${qualified} (id UInt32, raw String EPHEMERAL) ENGINE = MergeTree ORDER BY id`)
      await waitForDDLPropagation(executor, 'create_table', `table:${env.clickhouseDatabase}.${name}`)
      for (const statement of [
        `ALTER TABLE ${qualified} MODIFY COLUMN \`raw\` String EPHEMERAL 'seed';`,
        `ALTER TABLE ${qualified} MODIFY COLUMN \`raw\` String EPHEMERAL;`,
        `ALTER TABLE ${qualified} MODIFY COLUMN \`raw\` String EPHEMERAL concat('se', 'ed');`,
      ]) {
        await executor.command(statement)
        await waitForDDLPropagation(executor, 'alter_table_modify_column', key, { statement })
      }
      const columns = await everyReplica(
        executor,
        'system.columns',
        'default_kind, default_expression',
        `database = ${stringLiteral(env.clickhouseDatabase)} AND table = ${stringLiteral(name)} AND name = 'raw'`,
      )
      for (const replica of columns) {
        expect(replica).toEqual([{ default_kind: 'EPHEMERAL', default_expression: "concat('se', 'ed')" }])
      }
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${qualified} SYNC`)
      await executor.close()
    }
  }, 60_000)
})

/** `fields` of the rows matching `where`, one sorted list per replica. */
async function everyReplica(
  executor: ClickHouseExecutor,
  source: string,
  fields: string,
  where: string,
): Promise<Record<string, unknown>[][]> {
  const fanout = await resolveReplicaFanout(executor)
  const rows = await executor.query<Record<string, unknown> & { replica: string }>(
    `SELECT hostName() AS replica, ${fields} FROM ${fanout ? allReplicas(fanout, source) : source} WHERE ${where} ORDER BY replica, ${fields.split(',')[0]}`,
  )
  const replicas = [...new Set(rows.map((row) => row.replica))]
  expect(replicas).toHaveLength(fanout?.replicas ?? 1)
  return replicas.map((replica) =>
    rows.filter((row) => row.replica === replica).map(({ replica: _replica, ...rest }) => rest),
  )
}
