import { describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { waitForColumnAbsent } from '@chkit/clickhouse'

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
})

// chkit#291: an mv_replay of a `SELECT *` view writes each target column by
// name, as ClickHouse does when the view inserts into its TO table, whatever
// the target's column order or extra DEFAULT/MATERIALIZED/ALIAS columns. The
// source has a MATERIALIZED column the widened profile would add to `*`.
describe('mv_replay of a SELECT * view under a profile that widens SELECT *', () => {
  test('fills an extra DEFAULT column of a target outside the schema', async () => {
    const rows = await runMvReplay({
      label: 'bf_mv_default',
      targetColumns: 'id UInt64, event_time DateTime, a String, b String, x String DEFAULT \'xd\'',
      readColumns: 'id, a, b, x',
    })
    expect(rows).toEqual([{ id: '1', a: 'x', b: 'bx', x: 'xd' }])
  }, 120_000)

  test('matches reordered target columns by name and computes DEFAULTs from replayed values', async () => {
    const rows = await runMvReplay({
      label: 'bf_mv_reorder',
      targetColumns: 'b String, x String DEFAULT concat(a, \'_xd\'), a String, event_time DateTime, id UInt64',
      readColumns: 'id, a, b, x',
    })
    expect(rows).toEqual([{ id: '1', a: 'x', b: 'bx', x: 'x_xd' }])
  }, 120_000)

  test('recomputes MATERIALIZED and ALIAS target columns', async () => {
    const rows = await runMvReplay({
      label: 'bf_mv_computed',
      targetColumns: 'id UInt64, event_time DateTime, a String, b String, m String MATERIALIZED concat(a, \'_tm\'), al String ALIAS concat(b, \'_al\')',
      readColumns: 'id, a, b, m, al',
    })
    expect(rows).toEqual([{ id: '1', a: 'x', b: 'bx', m: 'x_tm', al: 'bx_al' }])
  }, 120_000)

  test('fills an extra DEFAULT column of a reordered target declared in the schema', async () => {
    const rows = await runMvReplay({
      label: 'bf_mv_declared',
      targetColumns: 'event_time DateTime, x String DEFAULT \'xd\', b String, a String, id UInt64',
      declareTarget: `[
        { name: 'event_time', type: 'DateTime' },
        { name: 'x', type: 'String', default: 'xd' },
        { name: 'b', type: 'String' },
        { name: 'a', type: 'String' },
        { name: 'id', type: 'UInt64' },
      ]`,
      readColumns: 'id, a, b, x',
    })
    expect(rows).toEqual([{ id: '1', a: 'x', b: 'bx', x: 'xd' }])
  }, 120_000)

  test('refuses to plan when the target lacks a column the view outputs', async () => {
    await withMvReplayFixture({
      label: 'bf_mv_missing',
      targetColumns: 'id UInt64, event_time DateTime, a String',
    }, async ({ fixture, target }) => {
      const plan = runCli(['plugin', 'backfill', 'plan', '--target', target, '--config', fixture.configPath, '--json'])
      expect(plan.exitCode, formatTestDiagnostic('backfill plan', plan)).toBe(2)
      expect(plan.stdout).toContain(`outputs column(s) b, which ${target} cannot take (missing, MATERIALIZED or ALIAS)`)
    })
  }, 120_000)

  test('refuses to run a plan whose target lost a replayed column', async () => {
    await withMvReplayFixture({
      label: 'bf_mv_altered',
      targetColumns: 'id UInt64, event_time DateTime, a String, b String, x String DEFAULT \'xd\'',
    }, async ({ db, fixture, prefix, target }) => {
      const planId = planMvReplay(fixture, target)
      await db.command(`ALTER TABLE ${target} DROP COLUMN b`)
      await waitForColumnAbsent(db, DATABASE, `${prefix}target`, 'b')

      const run = runCli(['plugin', 'backfill', 'run', '--plan-id', planId, '--poll-interval', '500', '--config', fixture.configPath, '--json'])
      expect(run.exitCode, formatTestDiagnostic('backfill run', run)).toBe(2)
      expect(run.stdout).toContain(`Target ${target} changed since plan ${planId} was created: column(s) b are gone or no longer insertable`)
      await waitForRowCount(db, target, 0)
    })
  }, 120_000)
})

interface MvReplayFixture {
  db: ReturnType<typeof createLiveExecutor>
  fixture: Awaited<ReturnType<typeof createFixture>>
  prefix: string
  target: string
}

/**
 * Plan and run an mv_replay backfill of a `SELECT *` view from the shared
 * source shape into a target with `targetColumns`, and return the target's
 * rows as strings.
 */
async function runMvReplay(input: {
  label: string
  targetColumns: string
  declareTarget?: string
  readColumns: string
}): Promise<Record<string, string>[]> {
  return withMvReplayFixture(input, async ({ db, fixture, target }) => {
    const planId = planMvReplay(fixture, target)
    const run = runCli(['plugin', 'backfill', 'run', '--plan-id', planId, '--poll-interval', '500', '--config', fixture.configPath, '--json'])
    expect(run.exitCode, formatTestDiagnostic('backfill run', run)).toBe(0)
    expect((JSON.parse(run.stdout) as { status: string }).status).toBe('completed')

    await waitForRowCount(db, target, 1)
    return db.query<Record<string, string>>(
      `SELECT ${input.readColumns.split(', ').map((column) => `toString(${column}) AS ${column}`).join(', ')}
       FROM ${target} ORDER BY id
       SETTINGS select_sequential_consistency = 1`,
    )
  })
}

function planMvReplay(fixture: Awaited<ReturnType<typeof createFixture>>, target: string): string {
  const plan = runCli(['plugin', 'backfill', 'plan', '--target', target, '--config', fixture.configPath, '--json'])
  expect(plan.exitCode, formatTestDiagnostic('backfill plan', plan)).toBe(0)
  const planned = JSON.parse(plan.stdout) as { planId: string; strategy: string }
  expect(planned.strategy).toBe('mv_replay')
  return planned.planId
}

/**
 * Create the source (with a MATERIALIZED column the profile adds to `*`) and
 * the target, insert one source row, and declare the `SELECT *` view (and
 * optionally the target) in the schema. The view itself is never created: the
 * replay reads its query from the schema.
 */
async function withMvReplayFixture<T>(
  input: { label: string; targetColumns: string; declareTarget?: string },
  body: (context: MvReplayFixture) => Promise<T>,
): Promise<T> {
  const prefix = createPrefix(input.label)
  const source = `${DATABASE}.${prefix}source`
  const target = `${DATABASE}.${prefix}target`
  const db = createLiveExecutor(env)
  const fixture = await createFixture()
  try {
    await db.command(`CREATE TABLE ${source} (
      id UInt64, event_time DateTime, a String, m String MATERIALIZED concat(a, '_m'), b String
    ) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
    await db.command(`CREATE TABLE ${target} (${input.targetColumns}
    ) ENGINE = MergeTree() PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)`)
    await waitForTable(db, DATABASE, `${prefix}source`)
    await waitForTable(db, DATABASE, `${prefix}target`)
    await db.command(`INSERT INTO ${source} (id, event_time, a, b) VALUES (1, '2026-01-01 12:00:00', 'x', 'bx')`)
    await waitForRowCount(db, source, 1)

    const declaredTarget = input.declareTarget
      ? `table({
  database: '${DATABASE}',
  name: '${prefix}target',
  engine: 'MergeTree()',
  partitionBy: 'toYYYYMMDD(event_time)',
  primaryKey: ['event_time', 'id'],
  orderBy: ['event_time', 'id'],
  columns: ${input.declareTarget},
}), `
      : ''
    await writeFile(fixture.schemaPath, `import { materializedView, schema, table } from '${CORE_ENTRY}'

export default schema(${declaredTarget}materializedView({
  database: '${DATABASE}',
  name: '${prefix}mv',
  to: { database: '${DATABASE}', name: '${prefix}target' },
  as: 'SELECT * FROM ${source}',
}))
`, 'utf8')
    await writeBackfillConfig(fixture)

    return await body({ db, fixture, prefix, target })
  } finally {
    await rm(fixture.dir, { recursive: true, force: true })
    await db.command(`DROP TABLE IF EXISTS ${source}`)
    await db.command(`DROP TABLE IF EXISTS ${target}`)
    await db.close()
  }
}

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
