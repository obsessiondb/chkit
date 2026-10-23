import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { table, type TableDefinition, type TableInput } from '@chkit/core'
import { renderSchemaFile } from '../../../plugin-pull/src/render-schema.js'
import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  pollUntil,
  runCli,
  runCliWithRetry,
  waitForCliJson,
  waitForTable,
} from './e2e-testkit.js'

// #278: vector_similarity skip indexes and table constraints, declared in the
// DSL, migrated, read back by drift and pull, changed, and dropped together
// with the column they read. Needs ClickHouse 25.8+ (vector search GA).
const env = getLiveEnv()

interface DriftPayload {
  drifted: boolean
  tableDrift: Array<{ reasonCodes: string[]; indexDiffs: string[]; constraintDiffs: string[] }>
}

function vectors(name: string, overrides: Partial<TableInput> = {}): TableDefinition {
  return table({
    database: env.clickhouseDatabase,
    name,
    engine: 'MergeTree()',
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: 's', type: 'String' },
      { name: 'embedding', type: 'Array(Float32)' },
    ],
    orderBy: ['id'],
    indexes: [
      {
        name: 'embedding_hnsw',
        expression: 'embedding',
        type: 'vector_similarity',
        method: 'hnsw',
        distanceFunction: 'cosineDistance',
        dimensions: 4,
      },
      // No structured form: kept verbatim.
      { name: 'sg', expression: 's', type: 'raw', rawType: 'sparse_grams(3,20, 256,2,0)', granularity: 1 },
    ],
    constraints: [
      { name: 'dimension', check: 'length(embedding) = 4' },
      // ClickHouse stores this as `(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)`.
      { name: 'allowed', check: "s IN ('a','b') AND (id+1)*2 > 0" },
      { name: 'positive-id', assume: 'id > 0' },
    ],
    ...overrides,
  })
}

test('vector indexes and constraints: generate, migrate, drift, pull, change, drop', async () => {
  const executor = createLiveExecutor(env)
  const [{ version }] = await executor.query<{ version: string }>('SELECT version() AS version')
  const [major = 0, minor = 0] = version.split('.').map(Number)
  expect(major > 25 || (major === 25 && minor >= 8), `ClickHouse ${version} predates vector search GA (25.8)`).toBe(true)

  const name = `${createPrefix('vec')}vectors`
  const definition = vectors(name)
  const fullName = `${definition.database}.${name}`
  const dir = await mkdtemp(join(tmpdir(), 'chkit-vector-'))
  const schemaPath = join(dir, 'schema.ts')
  const configPath = join(dir, 'clickhouse.config.ts')
  const journal = createJournalTableName('vector')
  const extraEnv = { CHKIT_JOURNAL_TABLE: journal }
  const command = (args: string[]) => {
    const result = runCli(dir, [...args, '--config', configPath, '--json'], extraEnv)
    if (result.exitCode !== 0) throw new Error(formatTestDiagnostic(args.join(' '), result))
    return JSON.parse(result.stdout)
  }
  const writeSchema = (value: TableDefinition) =>
    writeFile(schemaPath, renderSchemaFile([value]).replace("'@chkit/core'", JSON.stringify(CORE_ENTRY)))
  const migrate = async () => {
    const result = await runCliWithRetry(dir, ['migrate', '--execute', '--config', configPath, '--json'], { extraEnv })
    if (result.exitCode !== 0) throw new Error(formatTestDiagnostic('migrate', result))
  }
  const driftUntil = async (predicate: (payload: DriftPayload) => boolean) =>
    (await waitForCliJson<DriftPayload>(
      dir,
      ['drift', '--table', fullName, '--config', configPath, '--json'],
      predicate,
      { extraEnv, maxAttempts: 20 }
    )).payload
  const insert = (values: string) =>
    executor.command(`INSERT INTO ${fullName} (id, s, embedding) VALUES ${values}`)

  try {
    await writeFile(
      configPath,
      `export default ${JSON.stringify({ schema: schemaPath, outDir: join(dir, 'chkit'), migrationsDir: join(dir, 'chkit/migrations'), metaDir: join(dir, 'chkit/meta'), clickhouse: { url: env.clickhouseUrl, username: env.clickhouseUser, password: env.clickhousePassword, database: env.clickhouseDatabase } })}`
    )

    // 1. Create: drift reads the table back clean, the CHECK is enforced.
    await writeSchema(definition)
    command(['generate', '--name', 'init'])
    await migrate()
    await waitForTable(executor, definition.database, name)
    expect((await driftUntil((payload) => !payload.drifted)).drifted).toBe(false)
    await insert("(1, 'a', [0.1, 0.2, 0.3, 0.4])")
    await expect(insert("(2, 'a', [0.1, 0.2])")).rejects.toThrow(/dimension/)
    await expect(insert("(3, 'c', [0.1, 0.2, 0.3, 0.4])")).rejects.toThrow(/allowed/)

    // 2. Pull: the live table renders back to the same definition.
    const actual = await pollUntil(
      async () => (await executor.listTableDetails([definition.database])).find((item) => item.name === name),
      (item) => (item?.constraints?.length ?? 0) === 3
    )
    expect(actual?.indexes.map((index) => index.type).sort()).toEqual(['raw', 'vector_similarity'])
    const pulledPath = join(dir, 'pulled.ts')
    await writeFile(
      pulledPath,
      renderSchemaFile([{ ...definition, indexes: actual?.indexes, constraints: actual?.constraints }]).replace(
        "'@chkit/core'",
        JSON.stringify(CORE_ENTRY)
      )
    )
    const pulled: TableDefinition = (await import(pulledPath)).default[0]
    expect(pulled.constraints).toContainEqual({ name: 'allowed', check: "(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)" })
    expect(pulled.constraints).toContainEqual({ name: 'positive-id', assume: 'id > 0' })
    expect(pulled.indexes).toContainEqual(expect.objectContaining({
      type: 'vector_similarity', method: 'hnsw', distanceFunction: 'cosineDistance', dimensions: 4, granularity: 100_000_000,
    }))
    expect(pulled.indexes).toContainEqual(expect.objectContaining({ type: 'raw', rawType: 'sparse_grams(3, 20, 256, 2, 0)' }))
    // ClickHouse re-spells expressions, so the pulled strings differ from the
    // schema as written; drift formats both sides through ClickHouse.
    await writeSchema(pulled)
    expect((await driftUntil((payload) => !payload.drifted)).drifted).toBe(false)
    await writeSchema(definition)

    // 3. Out-of-band changes are drift, in both directions.
    await executor.command(`ALTER TABLE ${fullName} DROP CONSTRAINT dimension`)
    await executor.command(`ALTER TABLE ${fullName} ADD CONSTRAINT extra CHECK id < 1000000`)
    await executor.command(`ALTER TABLE ${fullName} DROP INDEX embedding_hnsw`)
    const outOfBand = await driftUntil(
      (payload) => (payload.tableDrift[0]?.constraintDiffs.length ?? 0) === 2 && (payload.tableDrift[0]?.indexDiffs.length ?? 0) === 1
    )
    expect(outOfBand.tableDrift[0]?.reasonCodes).toEqual(['index_mismatch', 'constraint_mismatch'])
    expect(outOfBand.tableDrift[0]?.constraintDiffs).toEqual(['dimension', 'extra'])
    expect(outOfBand.tableDrift[0]?.indexDiffs).toEqual(['embedding_hnsw'])
    await executor.command(`ALTER TABLE ${fullName} DROP CONSTRAINT extra`)
    await executor.command(`ALTER TABLE ${fullName} ADD CONSTRAINT dimension CHECK length(embedding) = 4`)
    await executor.command(
      `ALTER TABLE ${fullName} ADD INDEX embedding_hnsw embedding TYPE vector_similarity('hnsw', 'cosineDistance', 4) GRANULARITY 100000000`
    )
    await driftUntil((payload) => !payload.drifted)

    // 4. Change: a new distance function and tuning, a changed CHECK, a dropped
    // ASSUME and a new one. The changed ones are dropped and re-added.
    const changed = vectors(name, {
      indexes: [
        {
          name: 'embedding_hnsw',
          expression: 'embedding',
          type: 'vector_similarity',
          method: 'hnsw',
          distanceFunction: 'L2Distance',
          dimensions: 4,
          quantization: 'f32',
          hnswMaxConnectionsPerLayer: 16,
          hnswCandidateListSizeForConstruction: 64,
        },
      ],
      constraints: [
        { name: 'dimension', check: 'length(embedding) = 4' },
        { name: 'allowed', check: "s IN ('a','b','c')" },
        { name: 'small-id', assume: 'id < 1000000' },
      ],
    })
    await writeSchema(changed)
    const planned = command(['generate', '--dryrun'])
    command(['generate', '--name', 'change'])
    expect(planned.operations.map((op: { type: string }) => op.type)).toEqual([
      'alter_table_drop_constraint',
      'alter_table_drop_constraint',
      'alter_table_drop_index',
      'alter_table_drop_index',
      'alter_table_add_constraint',
      'alter_table_add_constraint',
      'alter_table_add_index',
    ])
    await migrate()
    expect((await driftUntil((payload) => !payload.drifted)).drifted).toBe(false)
    await insert("(4, 'c', [0.1, 0.2, 0.3, 0.4])")

    // 5. Drop the column with the index and constraint that read it: their drops
    // run first, or ClickHouse rejects the DROP COLUMN.
    const dropped = vectors(name, {
      columns: [{ name: 'id', type: 'UInt64' }, { name: 's', type: 'String' }],
      indexes: [],
      constraints: [{ name: 'allowed', check: "s IN ('a','b','c')" }],
    })
    await writeSchema(dropped)
    command(['generate', '--name', 'drop_embedding'])
    const result = await runCliWithRetry(
      dir,
      ['migrate', '--execute', '--allow-destructive', '--config', configPath, '--json'],
      { extraEnv }
    )
    expect(result.exitCode, formatTestDiagnostic('migrate drop', result)).toBe(0)
    expect((await driftUntil((payload) => !payload.drifted)).drifted).toBe(false)
  } finally {
    await executor.command(`DROP TABLE IF EXISTS ${fullName} SYNC`)
    await executor.command(`DROP TABLE IF EXISTS ${definition.database}.${journal} SYNC`)
    await executor.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 240_000)
