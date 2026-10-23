import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  pollUntil,
  waitForTable,
} from './e2e-testkit.js'
import { BACKFILL_PLUGIN_ENTRY, CORE_ENTRY, createFixture, runCli } from './testkit.test'

// chkit#243: backfill chunks run `INSERT INTO t SELECT * FROM t`. A user
// profile with asterisk_include_materialized_columns / asterisk_include_alias_columns
// enabled adds MATERIALIZED and ALIAS columns to `*`, but not to the INSERT's
// implicit column list. Without pinning those settings in the chunk query,
// copy mode fails with NUMBER_OF_COLUMNS_DOESNT_MATCH, and an mv_replay of a
// `SELECT *` view whose target has one more column silently shifts values.
//
// The profile is simulated with @clickhouse/client URL parameters, which every
// chkit client (including the fire-and-forget chunk submitter) sends with each
// request: the same layer a server-side settings profile sets.
const PROFILE_PARAMS = {
  ch_asterisk_include_materialized_columns: '1',
  ch_asterisk_include_alias_columns: '1',
}

const env = getLiveEnv()
const DATABASE = env.clickhouseDatabase

describe('backfill under a profile that widens SELECT *', () => {
  test('copy keeps stored DEFAULT values and recomputes MATERIALIZED/ALIAS columns', async () => {
    const result = await runCopyBackfill({
      label: 'bf_asterisk_mat',
      columns: `
        id UInt64,
        event_time DateTime,
        a String,
        m String MATERIALIZED concat(a, '_m'),
        al String ALIAS concat(a, '_al'),
        d String DEFAULT 'dflt',
        b String`,
      insert: `(id, event_time, a, d, b) VALUES
        (1, '2026-01-01 12:00:00', 'x', 'custom', 'bx'),
        (2, '2026-01-02 12:00:00', 'y', 'dflt', 'by')`,
      readColumns: 'id, a, m, al, d, b',
    })

    expect(result.starColumns).toEqual(['id', 'event_time', 'a', 'm', 'd', 'b', 'al'])
    expect(result.rows).toEqual([
      { id: '1', a: 'x', m: 'x_m', al: 'x_al', d: 'custom', b: 'bx', copies: '2' },
      { id: '2', a: 'y', m: 'y_m', al: 'y_al', d: 'dflt', b: 'by', copies: '2' },
    ])
  }, 120_000)

  test('copy of a table with EPHEMERAL inputs keeps the stored DEFAULT values derived from them', async () => {
    const result = await runCopyBackfill({
      label: 'bf_asterisk_eph',
      columns: `
        id UInt64,
        event_time DateTime,
        e String EPHEMERAL,
        a String DEFAULT upper(e),
        al String ALIAS concat(a, '_al'),
        b String`,
      insert: `(id, event_time, e, b) VALUES
        (1, '2026-01-01 12:00:00', 'x', 'bx'),
        (2, '2026-01-02 12:00:00', 'y', 'by')`,
      readColumns: 'id, a, al, b',
    })

    expect(result.starColumns).toEqual(['id', 'event_time', 'a', 'b', 'al'])
    expect(result.rows).toEqual([
      { id: '1', a: 'X', al: 'X_al', b: 'bx', copies: '2' },
      { id: '2', a: 'Y', al: 'Y_al', b: 'by', copies: '2' },
    ])
  }, 120_000)

  test('mv_replay of a SELECT * view never shifts source columns into other target columns', async () => {
    const prefix = createPrefix('bf_asterisk_mv')
    const source = `${DATABASE}.${prefix}source`
    const target = `${DATABASE}.${prefix}target`
    const db = createLiveExecutor(env)
    const fixture = await createFixture()
    try {
      await db.command(`CREATE TABLE ${source} (
        id UInt64, event_time DateTime, a String, m String MATERIALIZED concat(a, '_m'), b String
      ) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      // One column more than the source's insertable set: a widened `*` lines
      // up with it by count, so `m` would land in `b` and `b` in `x`.
      await db.command(`CREATE TABLE ${target} (
        id UInt64, event_time DateTime, a String, b String, x String DEFAULT 'xd'
      ) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
      await waitForTable(db, DATABASE, `${prefix}source`)
      await waitForTable(db, DATABASE, `${prefix}target`)
      await db.command(`INSERT INTO ${source} (id, event_time, a, b) VALUES (1, '2026-01-01 12:00:00', 'x', 'bx')`)
      await waitForRowCount(db, source, 1)

      // Only the view is declared, so the replay keeps its `SELECT *` projection.
      await writeFile(fixture.schemaPath, `import { materializedView, schema } from '${CORE_ENTRY}'

export default schema(materializedView({
  database: '${DATABASE}',
  name: '${prefix}mv',
  to: { database: '${DATABASE}', name: '${prefix}target' },
  as: 'SELECT * FROM ${source}',
}))
`, 'utf8')
      await writeBackfillConfig(fixture)

      const plan = runCli(['plugin', 'backfill', 'plan', '--target', target, '--config', fixture.configPath, '--json'])
      expect(plan.exitCode, formatTestDiagnostic('backfill plan', plan)).toBe(0)
      const planned = JSON.parse(plan.stdout) as { planId: string; strategy: string }
      expect(planned.strategy).toBe('mv_replay')

      const run = runCli(['plugin', 'backfill', 'run', '--plan-id', planned.planId, '--poll-interval', '500', '--config', fixture.configPath, '--json'])
      // Same result as without the profile: `*` reads 4 columns into a 5-column
      // target and ClickHouse refuses it. Before the fix this run completed
      // and wrote the shifted row.
      expect(run.exitCode, formatTestDiagnostic('backfill run', run)).toBe(1)
      expect(run.stdout).toContain("Number of columns doesn't match (source: 4 and result: 5)")
      const [row] = await db.query<{ cnt: string }>(
        `SELECT toString(count()) AS cnt FROM ${target} SETTINGS select_sequential_consistency = 1`,
      )
      expect(row?.cnt).toBe('0')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
      await db.command(`DROP TABLE IF EXISTS ${source}`)
      await db.command(`DROP TABLE IF EXISTS ${target}`)
      await db.close()
    }
  }, 120_000)
})

/**
 * Create a two-partition table, plan and run a copy backfill of it through the
 * CLI under the widened-asterisk profile, and return what `SELECT *` exposes
 * under that profile plus each distinct row with its number of copies.
 */
async function runCopyBackfill(input: {
  label: string
  columns: string
  insert: string
  readColumns: string
}): Promise<{ starColumns: string[]; rows: Record<string, string>[] }> {
  const table = `${createPrefix(input.label)}events`
  const fqn = `${DATABASE}.${table}`
  const db = createLiveExecutor(env)
  const profiled = createLiveExecutor({ ...env, clickhouseUrl: profileUrl(env.clickhouseUrl) })
  const fixture = await createFixture()
  try {
    await db.command(`CREATE TABLE ${fqn} (${input.columns}
    ) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
    await waitForTable(db, DATABASE, table)
    await db.command(`INSERT INTO ${fqn} ${input.insert}`)
    await waitForRowCount(db, fqn, 2)
    await writeBackfillConfig(fixture)

    // Guard against a vacuous test: the profile must actually widen `*`.
    const starColumns = await profiled.query<Record<string, unknown>>(`SELECT * FROM ${fqn} LIMIT 1`)

    const plan = runCli(['plugin', 'backfill', 'plan', '--target', fqn, '--from', '2026-01-01T00:00:00.000Z', '--to', '2026-01-03T00:00:00.000Z', '--config', fixture.configPath, '--json'])
    expect(plan.exitCode, formatTestDiagnostic('backfill plan', plan)).toBe(0)
    const planned = JSON.parse(plan.stdout) as { planId: string; strategy: string }
    expect(planned.strategy).toBe('copy')

    const run = runCli(['plugin', 'backfill', 'run', '--plan-id', planned.planId, '--poll-interval', '500', '--config', fixture.configPath, '--json'])
    expect(run.exitCode, formatTestDiagnostic('backfill run', run)).toBe(0)
    expect((JSON.parse(run.stdout) as { status: string }).status).toBe('completed')

    // Copy mode re-inserts the table into itself, so each row ends up twice.
    await waitForRowCount(db, fqn, 4)
    const rows = await db.query<Record<string, string>>(
      `SELECT ${input.readColumns.split(', ').map((column) => `toString(${column}) AS ${column}`).join(', ')}, toString(count()) AS copies
       FROM ${fqn} GROUP BY ${input.readColumns} ORDER BY id
       SETTINGS select_sequential_consistency = 1`,
    )
    return { starColumns: Object.keys(starColumns[0] ?? {}), rows }
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
    await db.command(`DROP TABLE IF EXISTS ${fqn}`)
    await db.close()
    await profiled.close()
  }
}

async function writeBackfillConfig(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  const pluginPath = join(fixture.dir, 'backfill-plugin.ts')
  await writeFile(pluginPath, `import { createBackfillPlugin } from '${BACKFILL_PLUGIN_ENTRY}'\n\nexport const plugin = createBackfillPlugin()\n`, 'utf8')
  await writeFile(fixture.configPath, `import { plugin } from '${pluginPath}'

export default {
  schema: '${fixture.schemaPath}',
  outDir: '${join(fixture.dir, 'chkit')}',
  migrationsDir: '${fixture.migrationsDir}',
  metaDir: '${fixture.metaDir}',
  clickhouse: {
    url: '${profileUrl(env.clickhouseUrl)}',
    username: '${env.clickhouseUser}',
    password: '${env.clickhousePassword}',
    database: '${DATABASE}',
  },
  plugins: [{ plugin }],
}
`, 'utf8')
}

function profileUrl(url: string): string {
  const parsed = new URL(url)
  for (const [key, value] of Object.entries(PROFILE_PARAMS)) parsed.searchParams.set(key, value)
  return parsed.toString()
}

async function waitForRowCount(db: ReturnType<typeof createLiveExecutor>, fqn: string, expected: number): Promise<void> {
  const count = await pollUntil(async () => {
    const [row] = await db.query<{ cnt: string }>(
      `SELECT toString(count()) AS cnt FROM ${fqn} SETTINGS select_sequential_consistency = 1`,
    )
    return Number(row?.cnt ?? 0)
  }, (value) => value === expected, { timeoutMs: 45_000 })
  expect(count, `rows in ${fqn}`).toBe(expected)
}
