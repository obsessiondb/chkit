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
// gives the schema and the snapshot the same value. On other targets it does nothing here.
const OBSESSIONDB_PLUGIN_ENTRY = resolve(import.meta.dir, '../../../plugin-obsessiondb/src/index.ts')

// On a database chkit migrated, pull then generate plans nothing and drift is
// clean (#466): the journal table is not pulled, literal defaults read back as
// expressions, every stored setting is pulled (index_granularity, floats in the
// form ClickHouse stores), hidden minmax indexes are left out, column types and
// LIFETIME compare in the form ClickHouse stores them.
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
      // ClickHouse stores these types with its own spacing (Decimal(10, 2)).
      { name: 'amount', type: 'Decimal(10,2)' },
      { name: 'at_utc', type: "DateTime64(3,'UTC')" },
      { name: 'attrs', type: 'Map(String,UInt64)' },
      { name: 'kind', type: "Enum8('a  b'=1,'c'=2)" },
      { name: 'maybe', type: 'Decimal(10,2)', nullable: true },
      // Defaults ClickHouse stores in another form (1e21) or a float cannot hold.
      { name: 'huge', type: 'Float64', default: 1e21 },
      { name: 'tiny', type: 'Float64', default: 1e-7 },
      { name: 'max_u64', type: 'UInt64', default: { expression: '18446744073709551615' } },
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
  // ObsessionDB keeps the parentheses chkit renders around an index
  // expression ('(s)'), stock ClickHouse drops them ('s'); a tuple reads back
  // as 'a, b' on both (#512).
  table({
    database: db, name: 'indexed', engine: 'MergeTree()', primaryKey: ['a'], orderBy: ['a'],
    columns: [
      { name: 'a', type: 'UInt32' }, { name: 'b', type: 'UInt32' },
      { name: 'c', type: 'UInt32' }, { name: 's', type: 'String' },
    ],
    indexes: [
      { name: 'idx_s', expression: 's', type: 'bloom_filter', falsePositiveRate: 0.01, granularity: 1 },
      { name: 'idx_nested', expression: '((lower(s)))', type: 'bloom_filter', granularity: 1 },
      { name: 'idx_tuple', expression: '(a, b)', type: 'minmax', granularity: 1 },
      { name: 'idx_arith', expression: '(a + b) * c', type: 'minmax', granularity: 1 },
      { name: 'idx_literal', expression: "s = ')('", type: 'set', maxRows: 10, granularity: 1 },
    ],
  }),
  table({
    database: db, name: 'daily', engine: 'MergeTree()', primaryKey: ['day'], orderBy: ['day'],
    columns: [{ name: 'day', type: 'Date' }, { name: 'c', type: 'UInt64' }],
  }),
  // Key columns whose names hold a comma or a space read back quoted (#558).
  table({
    database: db, name: 'keyed', engine: 'MergeTree()', orderBy: ['id', 'a, b', 'a b', 'cityHash64(a,b)'],
    columns: [
      { name: 'id', type: 'UInt64' }, { name: 'a', type: 'String' }, { name: 'b', type: 'String' },
      { name: 'a, b', type: 'String' }, { name: 'a b', type: 'String' }, { name: 'ab', type: 'String' },
    ],
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
      (result) => result.exitCode === 0 && (JSON.parse(result.stdout) as { definitionCount: number }).definitionCount === 11
    )
    expect(pulled.exitCode, formatTestDiagnostic('pull', pulled)).toBe(0)
    expect((JSON.parse(pulled.stdout) as { definitionCount: number }).definitionCount).toBe(11)
    const pulledContent = await readFile(pulledPath, 'utf8')
    expect(pulledContent).not.toContain(journalTable)
    expect(pulledContent).toContain('index_granularity')
    expect(pulledContent).not.toContain('auto_minmax_index')
    expect(pulledContent).toContain('Decimal(10, 2)')

    await writeFile(schemaPath, pulledContent.replace("'@chkit/core'", JSON.stringify(CORE_ENTRY)), 'utf8')
    const plan = runCli(dir, ['generate', '--config', configPath, '--dryrun', '--json'], cliEnv)
    expect(plan.exitCode, formatTestDiagnostic('generate from the pulled schema', plan)).toBe(0)
    expect((JSON.parse(plan.stdout) as { operations: unknown[] }).operations).toEqual([])

    const drift = runCli(dir, ['drift', '--config', configPath, '--json'], cliEnv)
    expect(drift.exitCode, formatTestDiagnostic('drift', drift)).toBe(0)
    expect(JSON.parse(drift.stdout)).toMatchObject({ drifted: false, tableDrift: [] })
    // Pull writes the form stock ClickHouse stores, on either server (#512).
    expect(pulledContent).toContain('expression: "s"')
    expect(pulledContent).toContain('expression: "lower(s)"')
    expect(pulledContent).toContain('expression: "(a + b) * c"')

    // The pulled key names the column `a, b`; as columns a and b it is another
    // key, which generate plans and drift reports (#558).
    expect(pulledContent).toContain('orderBy: ["id", "`a, b`", "`a b`", "cityHash64(a, b)"]')
    await writeFile(schemaPath, pulledContent.replace("'@chkit/core'", JSON.stringify(CORE_ENTRY)).replaceAll('"`a, b`"', '"a", "b"'), 'utf8')
    const rekeyed = runCli(dir, ['generate', '--config', configPath, '--dryrun', '--json'], cliEnv)
    expect(rekeyed.exitCode, formatTestDiagnostic('generate with columns a, b in the key', rekeyed)).toBe(0)
    expect((JSON.parse(rekeyed.stdout) as { operations: Array<{ type: string; key: string }> }).operations).toEqual([
      expect.objectContaining({ type: 'drop_table', key: `table:${database}.keyed` }),
      expect.objectContaining({ type: 'create_table', key: `table:${database}.keyed` }),
    ])
    // Drift compares the snapshot, which generate writes, with the live table.
    const regenerated = runCli(dir, ['generate', '--config', configPath, '--name', 'rekey', '--json'], cliEnv)
    expect(regenerated.exitCode, formatTestDiagnostic('generate rekey', regenerated)).toBe(0)
    const rekeyedDrift = runCli(dir, ['drift', '--config', configPath, '--json'], cliEnv)
    expect(rekeyedDrift.exitCode, formatTestDiagnostic('drift with columns a, b in the key', rekeyedDrift)).toBe(0)
    expect(JSON.parse(rekeyedDrift.stdout)).toMatchObject({
      drifted: true,
      tableDrift: [{ table: `${database}.keyed`, reasonCodes: ['primary_key_mismatch', 'order_by_mismatch'] }],
    })
  } finally {
    await executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(database)} SYNC`)
    await executor.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 240_000)

// Names that need escapes in SQL: a table, its columns and key, a view and a
// materialized view (whose TO target pull reads from the stored query), and a
// dictionary whose source names the table. The views and the source spell the
// names as ClickHouse stores them (#639).
test('pull then generate plans nothing for objects whose names need escapes', async () => {
  const env = getLiveEnv()
  const executor = createLiveExecutor(env)
  const database = `${createPrefix('pull_esc')}db`
  const journalTable = createJournalTableName('pull_esc')
  const dir = await mkdtemp(join(tmpdir(), 'chkit-pull-escapes-'))
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
  const q = (value: string) => JSON.stringify(value)
  await writeFile(
    schemaPath,
    `import { schema, table, view, materializedView, dictionary } from '${CORE_ENTRY}'

const db = ${q(database)}

export default schema(
  table({
    database: db, name: 'src', engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id'],
    columns: [{ name: 'id', type: 'UInt64' }],
  }),
  table({
    database: db, name: ${q('raw\\q')}, engine: 'MergeTree()', primaryKey: ['id'], orderBy: ['id', ${q('c\\q')}],
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: ${q('c\\q')}, type: 'String' },
      { name: ${q('c`d')}, type: 'String' },
      { name: ${q("c'e")}, type: 'String' },
    ],
  }),
  materializedView({
    database: db, name: ${q('mv\\q')}, to: { database: db, name: ${q('raw\\q')} },
    as: ${q(`SELECT id, toString(id) AS \`c\\\\q\` FROM ${database}.src`)},
  }),
  view({ database: db, name: ${q('v\\q')}, as: ${q(`SELECT id FROM ${database}.\`raw\\\\q\``)} }),
  view({ database: db, name: 'a_view', as: ${q(`SELECT id FROM ${database}.\`v\\\\q\``)} }),
  dictionary({
    database: db, name: ${q('d\\q')}, primaryKey: ['id'], layout: 'HASHED()', lifetime: 'MIN 0 MAX 300',
    source: ${q(`CLICKHOUSE(DB '${database}' TABLE 'raw\\\\q')`)},
    attributes: [{ name: 'id', type: 'UInt64' }, { name: 'v', type: 'String' }],
  }),
)
`,
    'utf8'
  )

  try {
    const generated = runCli(dir, ['generate', '--config', configPath, '--name', 'escapes', '--json'], cliEnv)
    expect(generated.exitCode, formatTestDiagnostic('generate', generated)).toBe(0)
    const migrated = await runCliWithRetry(dir, ['migrate', '--config', configPath, '--execute', '--json'], { extraEnv: cliEnv })
    expect(migrated.exitCode, formatTestDiagnostic('migrate --execute', migrated)).toBe(0)

    const pull = () => runCli(dir, ['pull', '--config', configPath, '--database', database, '--out-file', pulledPath, '--force', '--json'], cliEnv)
    const pulled = await pollUntil(
      async () => pull(),
      (result) => result.exitCode === 0 && (JSON.parse(result.stdout) as { definitionCount: number }).definitionCount === 6
    )
    expect(pulled.exitCode, formatTestDiagnostic('pull', pulled)).toBe(0)
    expect((JSON.parse(pulled.stdout) as { definitionCount: number }).definitionCount).toBe(6)
    const pulledContent = await readFile(pulledPath, 'utf8')
    expect(pulledContent).toContain(`to: { database: ${q(database)}, name: ${q('raw\\q')} }`)

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
