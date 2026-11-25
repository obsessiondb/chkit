import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { waitForDDLPropagation } from '@chkit/clickhouse'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  quoteIdent,
  runCli,
  runCliWithRetry,
  waitForRows,
  waitForTable,
} from './e2e-testkit.js'
import { createFixture } from './drift-fixture.js'

describe('@chkit/cli drift depth env e2e', () => {
  const liveEnv = getLiveEnv()

  test('every codec form migrates without drift, and server codec changes drift (#383, #465)', async () => {
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const codecTable = `${createPrefix('drift_codec')}metrics`
    const journalTable = createJournalTableName('drift_codec')
    const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable }
    const fixture = await createFixture({ database, usersTableName: codecTable })
    const object = `${quoteIdent(database)}.${quoteIdent(codecTable)}`
    const args = ['--config', fixture.configPath, '--table', `${database}.${codecTable}`, '--json']
    const codecsSql = `SELECT name, compression_codec FROM system.columns WHERE database = '${database}' AND table = '${codecTable}' ORDER BY name`

    try {
      await writeFile(fixture.schemaPath, `import { codec, schema, table } from '${CORE_ENTRY}'
export default schema(table({
  database: '${database}', name: '${codecTable}', engine: 'MergeTree()', orderBy: ['id'],
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'none', type: 'String', codec: { kind: 'NONE' } },
    { name: 'lz4', type: 'String', codec: { kind: 'LZ4' } },
    { name: 'zstd', type: 'String', codec: { kind: 'ZSTD' } },
    { name: 'zstd3', type: 'String', codec: { kind: 'ZSTD', level: 3 } },
    { name: 'zstd_negative', type: 'String', codec: { kind: 'ZSTD', level: -1 } },
    { name: 'lz4hc', type: 'String', codec: { kind: 'LZ4HC' } },
    { name: 'lz4hc0', type: 'String', codec: { kind: 'LZ4HC', level: 0 } },
    { name: 'lz4hc12', type: 'String', codec: { kind: 'LZ4HC', level: 12 } },
    { name: 't64', type: 'UInt64', codec: { kind: 'T64' } },
    { name: 't64_lz4', type: 'UInt64', codec: [{ kind: 'T64' }, { kind: 'LZ4' }] },
    { name: 't64_zstd3', type: 'UInt64', codec: [{ kind: 'T64' }, { kind: 'ZSTD', level: 3 }] },
    { name: 'delta_t64_lz4', type: 'UInt64', codec: [{ kind: 'Delta' }, { kind: 'T64' }, { kind: 'LZ4' }] },
    { name: 'gcd', type: 'UInt64', codec: [{ kind: 'GCD' }, { kind: 'LZ4' }] },
    { name: 'delta_gcd', type: 'UInt64', codec: [{ kind: 'Delta' }, { kind: 'GCD' }, { kind: 'ZSTD' }] },
    { name: 'delta', type: 'Int64', codec: [{ kind: 'Delta' }, { kind: 'ZSTD' }] },
    { name: 'delta8', type: 'Int64', codec: [{ kind: 'Delta', size: 8 }, { kind: 'LZ4' }] },
    { name: 'delta_t64', type: 'UInt32', codec: [{ kind: 'Delta', size: 4 }, { kind: 'T64' }] },
    { name: 'double_delta', type: 'Int64', codec: [{ kind: 'DoubleDelta' }, { kind: 'LZ4' }] },
    { name: 'double_delta4', type: 'DateTime', codec: [{ kind: 'DoubleDelta', size: 4 }, { kind: 'ZSTD', level: 2 }] },
    { name: 'gorilla', type: 'Float64', codec: [{ kind: 'Gorilla' }, { kind: 'LZ4' }] },
    { name: 'gorilla8', type: 'Float64', codec: [{ kind: 'Gorilla', size: 8 }, { kind: 'ZSTD', level: 2 }] },
    { name: 'fpc', type: 'Float64', codec: [{ kind: 'FPC', level: 12, floatSize: 8 }, { kind: 'LZ4' }] },
    { name: 'fpc4', type: 'Float32', codec: [{ kind: 'FPC', level: 5, floatSize: 4 }, { kind: 'LZ4HC' }] },
    { name: 'nullable_delta', type: 'Nullable(Int64)', codec: [{ kind: 'Delta', size: 8 }, { kind: 'LZ4' }] },
    { name: 'low_cardinality', type: 'LowCardinality(String)', codec: { kind: 'ZSTD' } },
    { name: 'low_cardinality_nullable', type: 'LowCardinality(String)', nullable: true, codec: { kind: 'ZSTD' } },
    { name: 'raw', type: 'String', codec: codec.raw('ZSTD') },
    { name: 'raw_chain', type: 'Int64', codec: codec.raw('Delta(8),ZSTD(3)') },
    { name: 'raw_fpc', type: 'Float64', codec: codec.raw('FPC, LZ4') },
    { name: 'mixed', type: 'Int32', codec: [{ kind: 'Delta', size: 4 }, codec.raw('ZSTD(3)')] },
    // #465: a bare Delta/Gorilla renders bare and ClickHouse fills in the value width.
    { name: 'delta_u32', type: 'UInt32', codec: [{ kind: 'Delta' }, { kind: 'ZSTD' }] },
    { name: 'delta_date', type: 'Date', codec: [{ kind: 'Delta' }, { kind: 'ZSTD' }] },
    { name: 'delta_dt64', type: 'DateTime64(3)', codec: [{ kind: 'Delta' }, { kind: 'ZSTD' }] },
    { name: 'delta_tuple', type: 'Tuple(a UInt8, b UInt64)', codec: [{ kind: 'Delta' }, { kind: 'LZ4' }] },
    { name: 'delta_mat', type: 'UInt64', defaultKind: 'MATERIALIZED', default: { expression: 'id * 2' }, codec: [{ kind: 'Delta' }, { kind: 'ZSTD' }] },
    { name: 'gorilla32', type: 'Float32', codec: { kind: 'Gorilla' } },
    { name: 'gorilla_arr', type: 'Array(Float64)', codec: [{ kind: 'Gorilla' }, { kind: 'ZSTD' }] },
    { name: 'zstd_window', type: 'String', codec: { kind: 'ZSTD', level: 3, windowLog: 24 } },
    { name: 't64_bit', type: 'UInt64', codec: { kind: 'T64', mode: 'bit' } },
    { name: 'fpc_bare', type: 'Float64', codec: { kind: 'FPC' } },
    { name: 'fpc12', type: 'Float64', codec: { kind: 'FPC', level: 12 } },
    { name: 'default_codec', type: 'UInt64', codec: { kind: 'Default' } },
    { name: 'delta_default', type: 'UInt64', codec: [{ kind: 'Delta' }, { kind: 'Default' }] },
    { name: 'raw_delta_default', type: 'UInt64', codec: codec.raw('Delta, Default') },
    { name: 'raw_aes', type: 'String', codec: codec.raw('ZSTD, AES_128_GCM_SIV') },
    { name: 'plain', type: 'String' },
  ],
}))
`, 'utf8')
      const generated = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'], cliEnv)
      if (generated.exitCode !== 0) throw new Error(formatTestDiagnostic('codec generate failed', generated))
      const migrated = await runCliWithRetry(
        fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--json'], { extraEnv: cliEnv }
      )
      if (migrated.exitCode !== 0) throw new Error(formatTestDiagnostic('codec migrate failed', migrated))
      await waitForTable(executor, database, codecTable)
      const stored = await waitForRows<{ name: string; compression_codec: string }>(executor, codecsSql,
        (rows) => rows.some((row) => row.name === 'raw_aes'),
        'codec columns'
      )
      const storedCodecs = new Map(stored.map((row) => [row.name, row.compression_codec]))
      expect(Object.fromEntries(['delta', 'delta_u32', 'delta_date', 'delta_dt64', 'delta_tuple', 'delta_mat', 'gorilla',
        'gorilla32', 'gorilla_arr', 'zstd_window', 't64_bit', 'fpc_bare', 'delta_default', 'raw_delta_default', 'raw_aes']
        .map((name) => [name, storedCodecs.get(name)]))).toEqual({
        delta: 'CODEC(Delta(8), ZSTD(1))',
        delta_u32: 'CODEC(Delta(4), ZSTD(1))',
        delta_date: 'CODEC(Delta(2), ZSTD(1))',
        delta_dt64: 'CODEC(Delta(8), ZSTD(1))',
        delta_tuple: 'CODEC(Delta, LZ4)',
        delta_mat: 'CODEC(Delta(8), ZSTD(1))',
        gorilla: 'CODEC(Gorilla(8), LZ4)',
        gorilla32: 'CODEC(Gorilla(4))',
        gorilla_arr: 'CODEC(Gorilla(8), ZSTD(1))',
        zstd_window: 'CODEC(ZSTD(3, 24))',
        t64_bit: "CODEC(T64('bit'))",
        fpc_bare: 'CODEC(FPC(12))',
        delta_default: 'CODEC(Delta(8), Default)',
        raw_delta_default: 'CODEC(Delta(8), Default)',
        raw_aes: 'CODEC(ZSTD(1), AES_128_GCM_SIV)',
      })

      const expectNoDrift = () => {
        const drift = runCli(fixture.dir, ['drift', ...args], cliEnv)
        expect(drift.exitCode).toBe(0)
        expect(JSON.parse(drift.stdout)).toMatchObject({ drifted: false, tableDrift: [] })
        const check = runCli(fixture.dir, ['check', '--strict', ...args], cliEnv)
        expect(check.exitCode).toBe(0)
        expect(JSON.parse(check.stdout)).toMatchObject({ ok: true, drifted: false, failedChecks: [] })
      }
      expectNoDrift()

      // One out-of-band ALTER at a time, each on every replica before the next:
      // on ObsessionDB an ALTER on a replica that has not applied the previous
      // one writes back its stale schema and loses that change (#709).
      const modifyColumn = async (column: string, change: string) => {
        const statement = `ALTER TABLE ${object} MODIFY COLUMN ${column} ${change}`
        await executor.command(statement)
        await waitForDDLPropagation(executor, 'alter_table_modify_column', `table:${database}.${codecTable}:column:${column}`, { statement })
      }

      // The same codecs, spelled the way ClickHouse fills in itself.
      await modifyColumn('lz4hc', 'CODEC(LZ4HC)')
      await modifyColumn('double_delta4', 'CODEC(DoubleDelta(8), ZSTD(2))')
      await modifyColumn('gorilla8', 'CODEC(Gorilla, ZSTD(2))')
      await waitForRows<{ name: string; compression_codec: string }>(executor, codecsSql,
        (rows) => rows.find((row) => row.name === 'lz4hc')?.compression_codec === 'CODEC(LZ4HC(0))',
        'equivalent codec respelling'
      )
      expectNoDrift()

      await modifyColumn('zstd3', 'String CODEC(LZ4)')
      await modifyColumn('plain', 'String CODEC(ZSTD(3))')
      await modifyColumn('lz4', 'REMOVE CODEC')
      await modifyColumn('zstd_window', 'CODEC(ZSTD(3))')
      await modifyColumn('delta8', 'CODEC(Delta(4), LZ4)')
      await modifyColumn('fpc12', 'CODEC(FPC(5))')
      await modifyColumn('t64', `CODEC(T64('bit'))`)
      await waitForRows<{ name: string; compression_codec: string }>(executor, codecsSql,
        (rows) => {
          const codecs = new Map(rows.map((row) => [row.name, row.compression_codec]))
          return codecs.get('zstd3') === 'CODEC(LZ4)' && codecs.get('plain') === 'CODEC(ZSTD(3))' && codecs.get('lz4') === '' &&
            codecs.get('t64') === "CODEC(T64('bit'))" && codecs.get('fpc12') === 'CODEC(FPC(5))' &&
            codecs.get('delta8') === 'CODEC(Delta(4), LZ4)' && codecs.get('zstd_window') === 'CODEC(ZSTD(3))'
        },
        'codec changes'
      )
      const changed = runCli(fixture.dir, ['drift', ...args], cliEnv)
      expect(changed.exitCode).toBe(0)
      const payload = JSON.parse(changed.stdout) as { drifted: boolean; tableDrift: Array<{ changedColumns: string[]; reasonCodes: string[] }> }
      expect(payload.drifted).toBe(true)
      expect(payload.tableDrift).toHaveLength(1)
      expect(payload.tableDrift[0]?.reasonCodes).toEqual(['changed_column'])
      expect([...(payload.tableDrift[0]?.changedColumns ?? [])].sort()).toEqual(['delta8', 'fpc12', 'lz4', 'plain', 't64', 'zstd3', 'zstd_window'])
      const strict = runCli(fixture.dir, ['check', '--strict', ...args], cliEnv)
      expect(strict.exitCode).toBe(1)
      expect(JSON.parse(strict.stdout)).toMatchObject({ ok: false, drifted: true, failedChecks: ['schema_drift'] })
    } finally {
      await executor.command(`DROP TABLE IF EXISTS ${object}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      await executor.close()
      await rm(fixture.dir, { recursive: true, force: true })
    }
  }, 240_000)
})
