import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  pollUntil,
  quoteIdent,
  runCli,
  runCliWithRetry,
} from './e2e-testkit.js'

const PULL_PLUGIN_ENTRY = resolve(import.meta.dir, '../../../plugin-pull/src/index.ts')
// ObsessionDB writes storage_policy = 's3' into every Shared table; its plugin
// leaves it out of the schema and the snapshot. On other targets it does nothing here.
const OBSESSIONDB_PLUGIN_ENTRY = resolve(import.meta.dir, '../../../plugin-obsessiondb/src/index.ts')

// On a database chkit migrated, pull then generate plans nothing and drift is
// clean (#466): the journal table is not pulled, literal defaults read back as
// expressions, every stored setting is pulled (index_granularity, floats in the
// form ClickHouse stores), hidden minmax indexes are left out, and the LIFETIME
// forms ClickHouse stores.
test('pull then generate plans nothing on a database chkit migrated', async () => {
  const env = getLiveEnv()
  const executor = createLiveExecutor(env)
  const database = `${createPrefix('pull_rt')}db`
  const journalTable = createJournalTableName('pull_rt')
  const dir = await mkdtemp(join(tmpdir(), 'chkit-pull-round-trip-'))
  const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, XDG_CONFIG_HOME: join(dir, 'xdg'), CI: '1' }
  const configPath = join(dir, 'clickhouse.config.ts')
  const schemaPath = join(dir, 'schema.ts')
  const pulledPath = join(dir, 'pulled.ts')
  const outDir = join(dir, 'chkit')
  const config = {
    schema: schemaPath,
    outDir,
    migrationsDir: join(outDir, 'migrations'),
    metaDir: join(outDir, 'meta'),
    clickhouse: { url: env.clickhouseUrl, username: env.clickhouseUser, password: env.clickhousePassword, database },
  }
  await writeFile(
    configPath,
    `import { pull } from '${PULL_PLUGIN_ENTRY}'\nimport { obsessiondb } from '${OBSESSIONDB_PLUGIN_ENTRY}'\n\nexport default ${JSON.stringify(config, null, 2).replace(/\n}$/, ',\n  plugins: [pull(), obsessiondb()],\n}')}\n`,
    'utf8'
  )
  await writeFile(
    schemaPath,
    `import { schema, table, view, materializedView, dictionary } from '${CORE_ENTRY}'

const db = '${database}'
const dict = (name: string, lifetime: string) => dictionary({
  database: db, name, primaryKey: ['k'], source: 'NULL()', layout: 'HASHED()', lifetime,
  attributes: [{ name: 'k', type: 'UInt64' }, { name: 'v', type: 'String' }],
})

export default schema(
  table({
    database: db, name: 'events', engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'],
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: 'n', type: 'UInt8', default: 7 },
      { name: 'source', type: 'String', default: 'web' },
      { name: 'quote', type: 'String', default: "it's" },
      { name: 'multiline', type: 'String', default: 'x\\ny\\tz' },
      { name: 'ratio', type: 'Float64', default: 2.0 },
      { name: 'received_at', type: 'DateTime64(3)', default: { expression: 'now64(3)' } },
    ],
  }),
  table({
    database: db, name: 'tuned', engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'],
    columns: [{ name: 'id', type: 'UInt64' }],
    settings: { index_granularity: 4096, merge_with_ttl_timeout: 3600 },
  }),
  table({
    database: db, name: 'minmax', engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'],
    columns: [{ name: 'id', type: 'UInt64' }, { name: 's', type: 'String' }],
    settings: { add_minmax_index_for_numeric_columns: 1, merge_selecting_sleep_slowdown_factor: 2.0 },
  }),
  table({
    database: db, name: 'daily', engine: 'MergeTree()', primaryKey: ['day'], orderBy: ['day'],
    columns: [{ name: 'day', type: 'Date' }, { name: 'c', type: 'UInt64' }],
  }),
  view({ database: db, name: 'recent', as: 'SELECT id, n FROM ${database}.events' }),
  materializedView({
    database: db, name: 'daily_mv', to: { database: db, name: 'daily' },
    as: 'SELECT toDate(received_at) AS day, count() AS c FROM ${database}.events GROUP BY day',
  }),
  dict('lookup_300', '300'),
  dict('lookup_min0', 'MIN 0 MAX 300'),
  dict('lookup_min10', 'MIN 10 MAX 300'),
)
`,
    'utf8'
  )

  try {
    const generated = runCli(dir, ['generate', '--config', configPath, '--name', `pull_rt_${database}`, '--json'], cliEnv)
    expect(generated.exitCode, formatTestDiagnostic('generate', generated)).toBe(0)
    const migrated = await runCliWithRetry(dir, ['migrate', '--config', configPath, '--execute', '--json'], { extraEnv: cliEnv })
    expect(migrated.exitCode, formatTestDiagnostic('migrate --execute', migrated)).toBe(0)

    // The replica that answers pull may not list every object yet.
    const pull = () => runCli(dir, ['pull', '--config', configPath, '--database', database, '--out-file', pulledPath, '--force', '--json'], cliEnv)
    const pulled = await pollUntil(
      async () => pull(),
      (result) => result.exitCode === 0 && (JSON.parse(result.stdout) as { definitionCount: number }).definitionCount === 9
    )
    expect(pulled.exitCode, formatTestDiagnostic('pull', pulled)).toBe(0)
    expect((JSON.parse(pulled.stdout) as { definitionCount: number }).definitionCount).toBe(9)
    const pulledContent = await readFile(pulledPath, 'utf8')
    expect(pulledContent).not.toContain(journalTable)
    expect(pulledContent).toContain('index_granularity')
    expect(pulledContent).not.toContain('auto_minmax_index')

    await writeFile(schemaPath, pulledContent.replace("'@chkit/core'", JSON.stringify(CORE_ENTRY)), 'utf8')
    const plan = runCli(dir, ['generate', '--config', configPath, '--dryrun', '--json'], cliEnv)
    expect(plan.exitCode, formatTestDiagnostic('generate from the pulled schema', plan)).toBe(0)
    expect((JSON.parse(plan.stdout) as { operations: unknown[] }).operations).toEqual([])

    const drift = runCli(dir, ['drift', '--config', configPath, '--json'], cliEnv)
    expect(drift.exitCode, formatTestDiagnostic('drift', drift)).toBe(0)
    expect(JSON.parse(drift.stdout)).toMatchObject({ drifted: false, tableDrift: [] })
  } finally {
    await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
    await executor.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 240_000)
