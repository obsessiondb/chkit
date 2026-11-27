/**
 * Zero-downtime cutover scenario (#202), shared by the default e2e suite
 * (local ClickHouse, ObsessionDB) and the 2-shard cluster suite.
 *
 * The table changes its ORDER BY while writers keep inserting, directly and
 * through a materialized view chained in front of it. A second materialized
 * view reads from the table. After the cutover the table must hold every row
 * exactly once, the reading view must have seen every row exactly once, and
 * chkit must report nothing pending, drifted or left to generate.
 */

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import type { TableDriftDetail } from '../commands/drift/compare.js'
import { isoWithoutZone } from '../commands/migrate/async-apply.js'
import { createJournalStore, type MigrationRowState } from '../runtime/journal-store.js'
import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  createStatelessLiveExecutor,
  formatTestDiagnostic,
  getLiveEnv,
  pollUntil,
  runCli,
  startCli,
  type CliResult,
} from './e2e-testkit.js'

const WORKSPACE_ROOT = join(import.meta.dir, '../../../..')
const BACKFILL_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-backfill/src/index.ts')
const HISTORIC_ROWS = 20_000
const BATCH_ROWS = 200
const NESTED_HISTORIC_ROWS = 2_000
const NESTED_COLUMNS = [
  { name: 'id', type: 'UInt64' },
  { name: 'user_id', type: 'UInt64' },
  { name: 'payload', type: 'String' },
  { name: 'n', type: 'Nested(x UInt64, `y z` Decimal64(2))' },
]
const NESTED_X = 'arrayMap(i -> id * 10 + i, range(id % 5 + 1))'
const NESTED_Y = 'arrayMap(i -> toDecimal64(id, 2) + toDecimal64(i * 10 + 5, 2) / 100, range(id % 5 + 1))'
const MIGRATE_TIMEOUT_MS = 600_000

export interface CutoverTarget {
  database: string
  connection: { url: string; username: string; password: string; database: string; cluster?: string }
  /** Runs DDL and verification reads. */
  admin: ClickHouseExecutor
  /** Stateless executors the concurrent writers insert through, round robin. */
  writers: [ClickHouseExecutor, ...ClickHouseExecutor[]]
  engine: string
  /** Every row of a table across shards: a qualified name, or cluster(...). */
  rowsOf: (table: string) => string
  /** Appended to verification reads, e.g. select_sequential_consistency on ObsessionDB. */
  readSettings: string
  /** Runs before verification reads, e.g. syncing the replicas of a cluster. */
  settle?: (tables: string[]) => Promise<void>
}

/** The default test target: the local stack, or ObsessionDB (CHKIT_E2E_TARGET=obsessiondb). */
export function liveCutoverTarget(): CutoverTarget {
  const env = getLiveEnv()
  const remote = env.clickhouseUrl.startsWith('https://')
  return {
    database: env.clickhouseDatabase,
    connection: {
      url: env.clickhouseUrl,
      username: env.clickhouseUser,
      password: env.clickhousePassword,
      database: env.clickhouseDatabase,
    },
    admin: createLiveExecutor(env),
    writers: [createStatelessLiveExecutor(env), createStatelessLiveExecutor(env)],
    engine: 'MergeTree',
    rowsOf: (table) => `${env.clickhouseDatabase}.${table}`,
    // A SharedMergeTree replica reads the parts every replica committed.
    readSettings: remote ? ' SETTINGS select_sequential_consistency = 1' : '',
  }
}

export interface CutoverProject {
  dir: string
  configPath: string
  journalTable: string
  env: Record<string, string>
  table: string
  byUser: string
  ingest: string
  previous: string
  /** Rows inserted before the cutover. */
  historic: number
  /** The table's columns in the schema, when they are not id, user_id and payload. */
  columns?: Array<Record<string, unknown>>
}

interface WriterReport {
  batches: number
  rows: number
  nestedRows: number
  errors: string[]
}

export async function createCutoverProject(
  target: CutoverTarget,
  label: string,
  columns?: Array<Record<string, unknown>>,
): Promise<CutoverProject> {
  const prefix = createPrefix(label)
  const dir = await mkdtemp(join(tmpdir(), `chkit-cutover-${label}-`))
  const project: CutoverProject = {
    dir,
    configPath: join(dir, 'clickhouse.config.ts'),
    journalTable: createJournalTableName(label),
    env: {},
    table: `${prefix}events`,
    byUser: `${prefix}events_by_user`,
    ingest: `${prefix}ingest`,
    previous: `${prefix}events_previous`,
    historic: HISTORIC_ROWS,
    columns,
  }
  project.env = { CHKIT_JOURNAL_TABLE: project.journalTable, CI: '1' }
  const config = {
    schema: join(dir, 'schema.ts'),
    outDir: join(dir, 'chkit'),
    migrationsDir: join(dir, 'chkit/migrations'),
    metaDir: join(dir, 'chkit/meta'),
    clickhouse: target.connection,
  }
  const backfillOptions = { stateDir: join(dir, 'chkit/backfill'), maxChunkBytes: 256 * 1024 }
  await writeFile(
    project.configPath,
    `import { backfill } from '${BACKFILL_ENTRY}'\n\nexport default { ...${JSON.stringify(config)}, plugins: [backfill(${JSON.stringify(backfillOptions)})] }\n`,
    'utf8',
  )
  await writeSchema(target, project, ['id'])
  expectOk(cli(project, ['generate', '--name', 'init', '--json']), 'generate init')
  expectOk(cli(project, ['migrate', '--apply', '--json']), 'migrate init')
  const db = target.database
  const half = HISTORIC_ROWS / 2
  const first = target.writers[0]
  const second = target.writers.at(-1) ?? first
  await first.command(`INSERT INTO ${db}.${project.table} (id, user_id, payload) SELECT number, number % 97, 'historic' FROM numbers(${half})`)
  await second.command(`INSERT INTO ${db}.${project.ingest} (id, user_id, payload) SELECT ${half} + number, number % 97, 'historic' FROM numbers(${half})`)
  return project
}

/** Rewrites the schema so the table sorts by `orderBy`, with `settings`. */
export async function writeSchema(
  target: CutoverTarget,
  project: CutoverProject,
  orderBy: string[],
  settings?: Record<string, number>,
): Promise<void> {
  const db = target.database
  const local = (name: string) => `${db}.${name}`
  const engine = JSON.stringify(target.engine)
  await writeFile(
    join(project.dir, 'schema.ts'),
    `import { schema, table, materializedView } from '${CORE_ENTRY}'

const columns = [
  { name: 'id', type: 'UInt64' },
  { name: 'user_id', type: 'UInt64' },
  { name: 'payload', type: 'String' },
]
${project.columns ? `const tableColumns = ${JSON.stringify(project.columns)}` : 'const tableColumns = columns'}

export default schema(
  table({ database: '${db}', name: '${project.table}', engine: ${engine}, columns: tableColumns, primaryKey: ${JSON.stringify(orderBy)}, orderBy: ${JSON.stringify(orderBy)}${settings ? `, settings: ${JSON.stringify(settings)}` : ''} }),
  table({ database: '${db}', name: '${project.byUser}', engine: ${engine}, columns: [{ name: 'user_id', type: 'UInt64' }, { name: 'id', type: 'UInt64' }], primaryKey: ['user_id'], orderBy: ['user_id', 'id'] }),
  materializedView({ database: '${db}', name: '${project.byUser}_mv', to: { database: '${db}', name: '${project.byUser}' }, as: 'SELECT user_id, id FROM ${local(project.table)}' }),
  table({ database: '${db}', name: '${project.ingest}', engine: ${engine}, columns, primaryKey: ['id'], orderBy: ['id'] }),
  materializedView({ database: '${db}', name: '${project.ingest}_mv', to: { database: '${db}', name: '${project.table}' }, as: 'SELECT id, user_id, payload FROM ${local(project.ingest)}' }),
)
`,
    'utf8',
  )
}

/**
 * Inserts batches of fresh ids until stopped, alternating a direct INSERT and
 * an INSERT into the chained source, round robin over the writer executors.
 * Only batches that succeeded count. A batch rejected with TABLE_UUID_MISMATCH
 * (741) overlapped the swap and wrote nothing, so it is retried once, as the
 * cutover guide tells writers to; any other error fails the scenario.
 */
function startWriters(target: CutoverTarget, project: CutoverProject, parallel = 2, nested = false): { stop: () => Promise<WriterReport> } {
  let stopped = false
  let next = 0
  const report: WriterReport = { batches: 0, rows: 0, nestedRows: 0, errors: [] }
  const db = target.database
  const loop = async (worker: number) => {
    while (!stopped) {
      const batch = next
      next += 1
      const writer = nested ? Math.floor(batch / 2) : batch
      const executor = target.writers[writer % target.writers.length] as ClickHouseExecutor
      const direct = batch % 2 === 0
      const into = direct ? project.table : project.ingest
      const withNested = nested && direct
      const start = 1_000_000_000 + batch * BATCH_ROWS
      const sql = withNested
        ? insertNestedSQL(`${db}.${into}`, start, BATCH_ROWS, `live-nested-${worker}`)
        : `INSERT INTO ${db}.${into} (id, user_id, payload) SELECT ${start} + number, number % 97, 'live-${worker}' FROM numbers(${BATCH_ROWS})`
      const insert = () => executor.command(sql)
      try {
        await insert().catch((error: unknown) => {
          if (!(error instanceof Error && 'code' in error && String(error.code) === '741')) throw error
          return insert()
        })
        report.batches += 1
        report.rows += BATCH_ROWS
        if (withNested) report.nestedRows += BATCH_ROWS
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : String(error))
      }
    }
  }
  const running = Array.from({ length: parallel }, (_, worker) => loop(worker))
  return {
    async stop() {
      stopped = true
      await Promise.all(running)
      return report
    },
  }
}

export function cli(project: CutoverProject, args: string[]): CliResult {
  return runCli(project.dir, [...args, '--config', project.configPath], project.env, { timeoutMs: MIGRATE_TIMEOUT_MS })
}

/** Like `cli`, without blocking the event loop, so writers keep inserting meanwhile. */
async function cliAsync(project: CutoverProject, args: string[]): Promise<CliResult> {
  return startCli(project.dir, [...args, '--config', project.configPath], project.env, {
    timeoutMs: MIGRATE_TIMEOUT_MS,
  }).result
}

function expectOk(result: CliResult, label: string): CliResult {
  if (result.exitCode !== 0) throw new Error(formatTestDiagnostic(label, result))
  return result
}

/** The cutover migration's file name (generated with --name cutover; init may share its timestamp). */
async function cutoverMigration(project: CutoverProject): Promise<string> {
  const files = (await readdir(join(project.dir, 'chkit/migrations'))).filter((file) => file.endsWith('_cutover.sql'))
  if (files.length !== 1) throw new Error(`expected one cutover migration, found ${files.join(', ')}`)
  return files[0] as string
}

async function readMigration(project: CutoverProject, file: string): Promise<string> {
  return readFile(join(project.dir, 'chkit/migrations', file), 'utf8')
}

async function rows<T>(target: CutoverTarget, sql: string): Promise<T[]> {
  return target.admin.query<T>(`${sql}${target.readSettings}`)
}

/**
 * Asserts the table holds the historic rows and every row a writer inserted,
 * each exactly once, that the view reading from it saw each of them exactly
 * once, and that its layout is `orderBy`.
 */
async function assertCutoverRows(
  target: CutoverTarget,
  project: CutoverProject,
  writers: WriterReport,
): Promise<{ total: number }> {
  const expected = project.historic + writers.rows
  await target.settle?.([project.table, project.byUser])
  const [counts] = await rows<{ total: number | string; ids: number | string; live: number | string }>(
    target,
    `SELECT count() AS total, uniqExact(id) AS ids, countIf(payload LIKE 'live%') AS live FROM ${target.rowsOf(project.table)}`,
  )
  const [byUser] = await rows<{ total: number | string; ids: number | string }>(
    target,
    `SELECT count() AS total, uniqExact(id) AS ids FROM ${target.rowsOf(project.byUser)}`,
  )
  const actual = {
    total: Number(counts?.total),
    ids: Number(counts?.ids),
    live: Number(counts?.live),
    byUserTotal: Number(byUser?.total),
    byUserIds: Number(byUser?.ids),
  }
  const want = { total: expected, ids: expected, live: writers.rows, byUserTotal: expected, byUserIds: expected }
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    throw new Error(`cutover rows: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)} (writer errors: ${writers.errors.length})`)
  }
  return { total: expected }
}

function insertNestedSQL(table: string, start: number, count: number, payload: string): string {
  return `INSERT INTO ${table} (id, user_id, payload, \`n.x\`, \`n.y z\`) SELECT ${start} + number AS id, number % 97, '${payload}', ${NESTED_X}, ${NESTED_Y} FROM numbers(${count})`
}

function storedColumns(target: CutoverTarget, project: CutoverProject): Promise<Array<{ name: string; type: string }>> {
  return target.admin.query(
    `SELECT name, type FROM system.columns WHERE database = '${target.database}' AND table = '${project.table}' ORDER BY position`,
  )
}

function nestedDrift(project: CutoverProject, table: string): TableDriftDetail {
  const payload = JSON.parse(expectOk(cli(project, ['drift', '--table', table, '--json']), 'drift').stdout) as { tableDrift: TableDriftDetail[] }
  const detail = payload.tableDrift.find((item) => item.table === table)
  // Drift reports the declared Nested name as missing and its stored leaves as extra.
  if (!detail || JSON.stringify([detail.reasonCodes, detail.missingColumns, detail.extraColumns]) !==
      JSON.stringify([['missing_column', 'extra_column'], ['n'], ['n.x', 'n.y z']])) {
    throw new Error(`unexpected Nested drift: ${JSON.stringify(payload)}`)
  }
  return detail
}

async function seedNested(target: CutoverTarget, project: CutoverProject) {
  const table = `${target.database}.${project.table}`
  const columns = await storedColumns(target, project)
  const drift = nestedDrift(project, table)
  const half = NESTED_HISTORIC_ROWS / 2
  const first = target.writers[0]
  const second = target.writers.at(-1) ?? first
  await first.command(insertNestedSQL(table, project.historic, half, 'nested-historic'))
  await second.command(insertNestedSQL(table, project.historic + half, half, 'nested-historic'))
  project.historic += NESTED_HISTORIC_ROWS
  return { columns, drift }
}

async function assertNestedRows(
  target: CutoverTarget,
  project: CutoverProject,
  before: Awaited<ReturnType<typeof seedNested>>,
  expected: number,
): Promise<void> {
  const [counts] = await rows<Record<'nested' | 'wrong_values' | 'nonempty' | 'unaligned', string | number>>(
    target,
    `WITH (payload LIKE 'nested-%' OR payload LIKE 'live-nested-%') AS is_nested
     SELECT countIf(is_nested) AS nested,
       countIf(is_nested AND (\`n.x\` != ${NESTED_X} OR \`n.y z\` != ${NESTED_Y})) AS wrong_values,
       countIf(NOT is_nested AND (notEmpty(\`n.x\`) OR notEmpty(\`n.y z\`))) AS nonempty,
       countIf(length(\`n.x\`) != length(\`n.y z\`)) AS unaligned
     FROM ${target.rowsOf(project.table)}`,
  )
  if (Number(counts?.nested) !== expected || Number(counts?.wrong_values) !== 0 ||
      Number(counts?.nonempty) !== 0 || Number(counts?.unaligned) !== 0) {
    throw new Error(`Nested rows: expected ${expected} valid rows, found ${JSON.stringify(counts)}`)
  }
  const columns = await storedColumns(target, project)
  if (JSON.stringify(columns) !== JSON.stringify(before.columns)) {
    throw new Error(`stored columns after cutover: ${JSON.stringify(columns)}; before: ${JSON.stringify(before.columns)}`)
  }
  const drift = nestedDrift(project, `${target.database}.${project.table}`)
  if (JSON.stringify(drift) !== JSON.stringify(before.drift)) {
    throw new Error(`Nested drift changed after cutover: ${JSON.stringify(drift)}`)
  }
}

/** A cutover's change: the new sort key and settings, and the layout `layouts` reports after it. */
export interface CutoverChange {
  orderBy: string[]
  settings?: Record<string, number>
  layout: string
}

const ORDER_BY_CHANGE: CutoverChange = { orderBy: ['user_id', 'id'], layout: 'user_id, id|8192' }
/** Only a read-only setting changes (#511): the guards must tell the tables apart by it. */
export const GRANULARITY_CHANGE: CutoverChange = { orderBy: ['id'], settings: { index_granularity: 4096 }, layout: 'id|4096' }

/** Sorting key and index_granularity of the table and every cutover table next to it. */
async function layouts(target: CutoverTarget, project: CutoverProject): Promise<Record<string, string>> {
  const result = await target.admin.query<{ name: string; sorting_key: string; granularity: string }>(
    `SELECT name, sorting_key, extract(engine_full, 'index_granularity = ([0-9]+)') AS granularity FROM system.tables WHERE database = '${target.database}' AND (name IN ('${project.table}', '${project.previous}') OR startsWith(name, '${project.table}__cutover_')) ORDER BY name`,
  )
  return Object.fromEntries(
    result.map((row) => [row.name, `${row.sorting_key.replace(/^\(|\)$/g, '')}|${row.granularity || '8192'}`]),
  )
}

async function sortingKeys(target: CutoverTarget, project: CutoverProject): Promise<Record<string, string>> {
  const result = await target.admin.query<{ name: string; sorting_key: string }>(
    `SELECT name, sorting_key FROM system.tables WHERE database = '${target.database}' AND (name IN ('${project.table}', '${project.previous}') OR startsWith(name, '${project.table}__cutover_')) ORDER BY name`,
  )
  return Object.fromEntries(result.map((row) => [row.name, row.sorting_key.replace(/^\(|\)$/g, '')]))
}

/** check (no pending migration, no drift) and generate --dryrun report nothing to do. */
function assertChkitClean(project: CutoverProject, nested = false): void {
  const check = cli(project, ['check', '--json'])
  const payload = JSON.parse(check.stdout) as { pendingCount: number; driftEvaluated: boolean; drifted: boolean; failedChecks: string[] }
  const plan = JSON.parse(expectOk(cli(project, ['generate', '--dryrun', '--json']), 'generate --dryrun').stdout) as { operationCount: number }
  const summary = {
    check: check.exitCode,
    pending: payload.pendingCount,
    driftEvaluated: payload.driftEvaluated,
    drifted: payload.drifted,
    failedChecks: payload.failedChecks,
    operations: plan.operationCount,
  }
  if (JSON.stringify(summary) !== JSON.stringify({ check: nested ? 1 : 0, pending: 0, driftEvaluated: true, drifted: nested, failedChecks: nested ? ['schema_drift'] : [], operations: 0 })) {
    throw new Error(`chkit not clean after the cutover: ${JSON.stringify(summary)}\n${formatTestDiagnostic('check', check)}`)
  }
}

/** Reads and rewrites the cutover migration's journal state, e.g. to simulate a lost acknowledgement. */
async function editJournalState(
  target: CutoverTarget,
  project: CutoverProject,
  file: string,
  edit: (state: MigrationRowState) => MigrationRowState,
): Promise<void> {
  const previous = process.env.CHKIT_JOURNAL_TABLE
  process.env.CHKIT_JOURNAL_TABLE = project.journalTable
  try {
    const store = createJournalStore(target.admin, target.connection.cluster)
    const state = await store.readMigrationState(file)
    if (!state) throw new Error(`no journal state for ${file}`)
    await store.writeMigrationState(edit(state))
  } finally {
    if (previous === undefined) delete process.env.CHKIT_JOURNAL_TABLE
    else process.env.CHKIT_JOURNAL_TABLE = previous
  }
}

/** Drops every object the scenario created, including the cutover's leftovers. */
export async function dropCutoverProject(target: CutoverTarget, project: CutoverProject): Promise<void> {
  const onCluster = target.connection.cluster ? ` ON CLUSTER '${target.connection.cluster}'` : ''
  const objects = await target.admin.query<{ name: string }>(
    `SELECT name FROM system.tables WHERE database = '${target.database}' AND (startsWith(name, '${project.table}') OR startsWith(name, '${project.byUser}') OR startsWith(name, '${project.ingest}')) ORDER BY engine = 'MaterializedView' DESC`,
  )
  for (const { name } of objects) {
    await target.admin.command(`DROP TABLE IF EXISTS ${target.database}.\`${name}\`${onCluster} SYNC`)
  }
  await target.admin.command(`DROP TABLE IF EXISTS ${target.database}.\`${project.journalTable}\`${onCluster} SYNC`)
}

/**
 * The default cutover: the copy runs inside the migration and the old table
 * is kept as `<table>_previous`, while writers insert the whole time.
 */
export async function runKeepScenario(target: CutoverTarget, label: string, nested = false): Promise<void> {
  const project = await createCutoverProject(target, label, nested ? NESTED_COLUMNS : undefined)
  try {
    const before = nested ? await seedNested(target, project) : undefined
    await writeSchema(target, project, ['user_id', 'id'])
    const generated = JSON.parse(
      expectOk(cli(project, ['generate', '--name', 'cutover', '--cutover', `${target.database}.${project.table}=id`, '--json']), 'generate --cutover').stdout,
    ) as { riskSummary: { danger: number }; cutovers: Array<{ retainedAs: string }> }
    if (generated.riskSummary.danger !== 0) throw new Error('a keep-mode cutover must not be destructive')
    if (generated.cutovers[0]?.retainedAs !== `${target.database}.${project.previous}`) throw new Error('missing retained table')

    const writers = startWriters(target, project, 4, nested)
    const migrate = await cliAsync(project, ['migrate', '--apply', '--json'])
    const report = await writers.stop()
    expectOk(migrate, 'migrate --apply (cutover)')
    if (report.errors.length > 0) throw new Error(`writers failed during the cutover: ${report.errors[0]}`)
    if (report.batches < 4) throw new Error(`writers inserted only ${report.batches} batches during the cutover`)

    await assertCutoverRows(target, project, report)
    const keys = await sortingKeys(target, project)
    const want = { [project.table]: 'user_id, id', [project.previous]: 'id' }
    if (JSON.stringify(keys) !== JSON.stringify(want)) throw new Error(`layouts after the cutover: ${JSON.stringify(keys)}`)
    // The old table kept every row it received until the mirror was dropped.
    // The rows of an INSERT that straddled the swap are in it twice (and were
    // attached to the new table by the reconcile step).
    await target.settle?.([project.previous])
    const [previous] = await rows<{ total: number | string; ids: number | string }>(
      target,
      `SELECT count() AS total, uniqExact(id) AS ids FROM ${target.rowsOf(project.previous)}`,
    )
    if (Number(previous?.total) < Number(previous?.ids) || Number(previous?.ids) < project.historic) {
      throw new Error(`old table after the cutover: ${JSON.stringify(previous)}`)
    }
    if (before) await assertNestedRows(target, project, before, NESTED_HISTORIC_ROWS + report.nestedRows)
    assertChkitClean(project, nested)
  } finally {
    await dropCutoverProject(target, project)
  }
}

/**
 * The backfill copy: the migration stops at the copy check, the backfill
 * plugin copies the snapshot, and the next apply verifies and swaps. The old
 * table is dropped.
 */
export async function runBackfillScenario(target: CutoverTarget, label: string, nested = false): Promise<void> {
  const project = await createCutoverProject(target, label, nested ? NESTED_COLUMNS : undefined)
  try {
    const before = nested ? await seedNested(target, project) : undefined
    await writeSchema(target, project, ['user_id', 'id'])
    const fqn = `${target.database}.${project.table}`
    expectOk(
      cli(project, ['generate', '--name', 'cutover', '--cutover', `${fqn}=id`, '--cutover-copy', 'backfill', '--cutover-old', 'drop', '--json']),
      'generate --cutover backfill',
    )
    const writers = startWriters(target, project, 2, nested)
    const copied = (async () => {
      const stopped = await cliAsync(project, ['migrate', '--apply', '--allow-destructive', '--json'])
      if (stopped.exitCode !== 1 || !`${stopped.stdout}${stopped.stderr}`.includes(`chkit plugin backfill plan --cutover ${fqn}`)) {
        throw new Error(formatTestDiagnostic('migrate must stop at the copy check', stopped))
      }
      if (nested) {
        await target.admin.command(insertNestedSQL(fqn, project.historic, BATCH_ROWS, 'nested-paused'))
        project.historic += BATCH_ROWS
      }
      const plan = JSON.parse(expectOk(await cliAsync(project, ['plugin', 'backfill', 'plan', '--cutover', fqn, '--json']), 'backfill plan').stdout) as {
        planId: string
        strategy: string
        chunkCount: number
      }
      if (plan.strategy !== 'cutover_copy' || plan.chunkCount < 2) throw new Error(`unexpected backfill plan: ${JSON.stringify(plan)}`)
      expectOk(
        await cliAsync(project, ['plugin', 'backfill', 'run', '--plan-id', plan.planId, '--poll-interval', '200', '--json']),
        'backfill run',
      )
      expectOk(await cliAsync(project, ['migrate', '--apply', '--allow-destructive', '--json']), 'migrate --apply after the backfill')
    })()
    // Writers stop whether or not the steps succeed; a failed step is reported after.
    const [outcome] = await Promise.allSettled([copied])
    const report = await writers.stop()
    if (outcome.status === 'rejected') throw outcome.reason
    if (report.errors.length > 0) throw new Error(`writers failed during the cutover: ${report.errors[0]}`)
    await assertCutoverRows(target, project, report)
    const keys = await sortingKeys(target, project)
    if (JSON.stringify(keys) !== JSON.stringify({ [project.table]: 'user_id, id' })) {
      throw new Error(`only the cut-over table may remain, found ${JSON.stringify(keys)}`)
    }
    if (before) await assertNestedRows(target, project, before, NESTED_HISTORIC_ROWS + report.nestedRows + BATCH_ROWS)
    assertChkitClean(project, nested)
  } finally {
    await dropCutoverProject(target, project)
  }
}

/**
 * Which statements of the cutover fail once. `retries`: every statement whose
 * retry runs other SQL than its first run (before-retry SQL, or the lookup of
 * an async attempt), and the statement after each one whose acknowledgement
 * is lost. A retry of any other statement only runs it again, which
 * apply-resume.test.ts covers. `layout guards`: the EXCHANGE and the drop of
 * the old table, whose guards compare the tables' layouts.
 */
export type RetryFailures = 'retries' | 'layout guards'

/**
 * Fails statements of the cutover once (see RetryFailures) and resumes them
 * with --retry, and replays the statements whose acknowledgement can be lost:
 * the snapshot (re-taken after a TRUNCATE), the copy (skips what it wrote),
 * the EXCHANGE (refuses: it must never swap back) and the drop of the old
 * table. Writers insert the whole time; no row may be lost or duplicated.
 */
export async function runRetryScenario(
  target: CutoverTarget,
  label: string,
  change: CutoverChange = ORDER_BY_CHANGE,
  failures: RetryFailures = 'retries',
): Promise<void> {
  const project = await createCutoverProject(target, label)
  const writers = startWriters(target, project, 1)
  let stopped: WriterReport | undefined
  try {
    await writeSchema(target, project, change.orderBy, change.settings)
    expectOk(
      cli(project, ['generate', '--name', 'cutover', '--cutover', `${target.database}.${project.table}=id`, '--cutover-old', 'drop', '--json']),
      'generate --cutover drop',
    )
    const file = await cutoverMigration(project)
    const original = await readMigration(project, file)
    const blocks = original.split('\n\n')
    const types = blocks.slice(1).map((block) => /^-- operation: (\S+)/.exec(block)?.[1] ?? '')
    const dropOld = blocks.slice(1).findIndex((block) => block.includes(' risk=danger'))
    const replayed = new Map([
      [types.indexOf('cutover_snapshot'), 'replays'],
      [types.indexOf('cutover_copy'), 'replays'],
      [types.indexOf('exchange_tables'), 'refuses'],
      [types.indexOf('cutover_reconcile'), 'replays'],
      [types.lastIndexOf('cutover_reconcile'), 'replays'],
      // Refused when the staging table holds rows (an INSERT straddled the swap).
      [types.indexOf('cutover_attach'), 'refuses if staged'],
      [dropOld, 'replays'],
    ])
    const migrate = (retry: boolean) =>
      cliAsync(project, ['migrate', '--apply', '--allow-destructive', '--json', ...(retry ? ['--retry', file] : [])])
    const write = (content: string) => writeFile(join(project.dir, 'chkit/migrations', file), content, 'utf8')

    const exchange = types.indexOf('exchange_tables')
    const retryRunsOtherSql = (step: number) => /^-- before-retry:|^-- operation: .* mode=async\b/m.test(blocks[step + 1] as string)
    const steps =
      failures === 'layout guards'
        ? [exchange, exchange + 1, dropOld]
        : types.flatMap((_, step) => (retryRunsOtherSql(step) || replayed.has(step - 1) ? [step] : []))
    for (const [attempt, step] of steps.entries()) {
      await write(injectFailure(blocks, step))
      const failed = await migrate(attempt > 0)
      if (failed.exitCode === 0 || !`${failed.stdout}${failed.stderr}`.includes(`injected failure at statement ${step + 1}`)) {
        throw new Error(formatTestDiagnostic(`statement ${step + 1} (${types[step]}) must fail`, failed))
      }
      const lost = replayed.get(step - 1)
      if (lost === undefined) continue
      // The previous statement ran, but its acknowledgement was lost: it is
      // recorded as started, and this statement never ran.
      await editJournalState(target, project, file, (state) => ({
        ...state,
        // A newer version, so FINAL reads it instead of the recorded one.
        appliedAt: isoWithoutZone(new Date()),
        operations: state.operations
          .filter((op) => op.operationIndex !== step)
          .map((op) => (op.operationIndex === step - 1 ? { ...op, status: 'started', finishedAt: null, queryId: '' } : op)),
      }))
      if (lost === 'replays') continue
      await write(injectFailure(blocks, step + 1))
      const replay = await migrate(true)
      const output = `${replay.stdout}${replay.stderr}`
      if (lost === 'refuses') {
        if (replay.exitCode === 0 || !output.includes('the EXCHANGE may already have run')) {
          throw new Error(formatTestDiagnostic('a replayed EXCHANGE must be refused', replay))
        }
        const keys = await layouts(target, project)
        if (keys[project.table] !== change.layout) throw new Error(`the refused replay swapped the tables back: ${JSON.stringify(keys)}`)
      } else if (!output.includes('the ATTACH may already have run')) {
        // Nothing was staged, so the replayed ATTACH ran and the next statement failed.
        if (!output.includes(`injected failure at statement ${step + 2}`)) {
          throw new Error(formatTestDiagnostic('a replayed empty ATTACH must run', replay))
        }
        continue
      }
      // Documented recovery: the statement ran, so it becomes a no-op.
      blocks[step] = (blocks[step] as string)
        .split('\n')
        .filter((line) => !line.startsWith('-- before-retry:'))
        .map((line) => (line.startsWith('EXCHANGE TABLES') || line.startsWith('ALTER TABLE') ? 'SELECT 1;' : line))
        .join('\n')
    }
    await write(blocks.join('\n\n'))
    expectOk(await migrate(true), 'migrate --apply --retry (complete)')
    stopped = await writers.stop()
    if (stopped.errors.length > 0) throw new Error(`writers failed during the cutover: ${stopped.errors[0]}`)
    await assertCutoverRows(target, project, stopped)
    const keys = await layouts(target, project)
    if (JSON.stringify(keys) !== JSON.stringify({ [project.table]: change.layout })) {
      throw new Error(`only the cut-over table may remain, found ${JSON.stringify(keys)}`)
    }
    assertChkitClean(project)
  } finally {
    if (!stopped) await writers.stop()
    await dropCutoverProject(target, project)
  }
}

/**
 * A table created with only ORDER BY, as outside chkit (#524). Before
 * ClickHouse 26.7 its parts attach only to a table that leaves PRIMARY KEY
 * out too, so the snapshot must copy the table's stored definition.
 */
export async function runUndeclaredPrimaryKeyScenario(target: CutoverTarget, label: string): Promise<void> {
  const project = await createCutoverProject(target, label)
  try {
    const fqn = `${target.database}.${project.table}`
    await target.admin.command(`DROP TABLE ${fqn} SYNC`)
    await target.admin.command(`CREATE TABLE ${fqn} (id UInt64, user_id UInt64, payload String) ENGINE = ${target.engine} ORDER BY id`)
    const [created] = await pollUntil(
      () => target.admin.query<{ engine_full: string }>(`SELECT engine_full FROM system.tables WHERE database = '${target.database}' AND name = '${project.table}'`),
      (found) => found.length > 0,
    )
    if (created === undefined || created.engine_full.includes(' PRIMARY KEY ')) throw new Error(`the table must have no PRIMARY KEY, found ${JSON.stringify(created)}`)
    await target.admin.command(`INSERT INTO ${fqn} (id, user_id, payload) SELECT number, number % 97, 'historic' FROM numbers(1000)`)

    await writeSchema(target, project, ['user_id', 'id'])
    expectOk(cli(project, ['generate', '--name', 'cutover', '--cutover', `${fqn}=id`, '--json']), 'generate --cutover')
    expectOk(cli(project, ['migrate', '--apply', '--json']), 'migrate --apply (cutover)')
    const keys = await sortingKeys(target, project)
    if (JSON.stringify(keys) !== JSON.stringify({ [project.table]: 'user_id, id', [project.previous]: 'id' })) {
      throw new Error(`layouts after the cutover: ${JSON.stringify(keys)}`)
    }
    const [count] = await rows<{ total: number | string }>(target, `SELECT count() AS total FROM ${target.rowsOf(project.table)}`)
    if (Number(count?.total) !== 1000) throw new Error(`the new table must hold the 1000 rows, found ${JSON.stringify(count)}`)
    assertChkitClean(project)
  } finally {
    await dropCutoverProject(target, project)
  }
}

/**
 * The table is created outside chkit with `columns` and the engine that
 * `engine` returns for its name, which differ from the schema (`schemaColumns`,
 * or id, user_id and payload). The snapshot is created AS the table, so it
 * would take the server's state: the cutover must stop at its first statement,
 * before it creates anything.
 */
export async function runRefusedAtStartScenario(
  target: CutoverTarget,
  label: string,
  created: { columns: string; engine: (table: string) => string; orderBy?: string; clauses?: string; settings?: Record<string, number> },
  message: string,
  schemaColumns?: Array<Record<string, unknown>>,
): Promise<void> {
  const project = await createCutoverProject(target, label, schemaColumns)
  try {
    const fqn = `${target.database}.${project.table}`
    const cluster = target.connection.cluster
    const onCluster = cluster ? ` ON CLUSTER '${cluster}'` : ''
    await target.admin.command(`DROP TABLE ${fqn}${onCluster} SYNC`)
    await target.admin.command(
      `CREATE TABLE ${fqn}${onCluster} (${created.columns}) ENGINE = ${created.engine(project.table)} ORDER BY ${created.orderBy ?? 'id'}${created.clauses ? ` ${created.clauses}` : ''}`,
      created.settings,
    )
    await pollUntil(
      () => target.admin.query<{ name: string }>(`SELECT name FROM system.tables WHERE database = '${target.database}' AND name = '${project.table}'`),
      (found) => found.length > 0,
    )

    await writeSchema(target, project, ['user_id', 'id'])
    expectOk(cli(project, ['generate', '--name', 'cutover', '--cutover', `${fqn}=id`, '--json']), 'generate --cutover')
    const refused = cli(project, ['migrate', '--apply', '--json'])
    const output = `${refused.stdout}${refused.stderr}`
    if (refused.exitCode === 0 || !output.includes(message) || !output.includes('failed at statement 1 of')) {
      throw new Error(formatTestDiagnostic(`migrate --apply must stop with "${message}"`, refused))
    }
    const tables = cluster ? `clusterAllReplicas('${cluster}', system.tables)` : 'system.tables'
    const leftovers = await target.admin.query<{ name: string }>(
      `SELECT name FROM ${tables} WHERE database = '${target.database}' AND startsWith(name, '${project.table}__cutover_')`,
    )
    if (leftovers.length > 0) throw new Error(`the cutover must create nothing, found ${JSON.stringify(leftovers)}`)
  } finally {
    await dropCutoverProject(target, project)
  }
}

/**
 * The table is created outside chkit with `columns`, `clauses` after its
 * ORDER BY and the query `settings`, in a form the schema (`schemaColumns`)
 * describes but chkit would not write: the cutover must accept it.
 */
export async function runCreatedOutsideChkitScenario(
  target: CutoverTarget,
  label: string,
  created: { columns: string; orderBy?: string; clauses?: string; settings?: Record<string, number> },
  schemaColumns: Array<Record<string, unknown>>,
): Promise<void> {
  const project = await createCutoverProject(target, label, schemaColumns)
  try {
    const fqn = `${target.database}.${project.table}`
    await target.admin.command(`DROP TABLE ${fqn} SYNC`)
    await target.admin.command(
      `CREATE TABLE ${fqn} (${created.columns}) ENGINE = ${target.engine} ORDER BY ${created.orderBy ?? 'id'}${created.clauses ? ` ${created.clauses}` : ''}`,
      created.settings,
    )
    await pollUntil(
      () => target.admin.query<{ name: string }>(`SELECT name FROM system.tables WHERE database = '${target.database}' AND name = '${project.table}'`),
      (found) => found.length > 0,
    )
    await target.admin.command(`INSERT INTO ${fqn} (id, user_id, payload) SELECT number, number % 97, 'historic' FROM numbers(1000)`)

    await writeSchema(target, project, ['user_id', 'id'])
    expectOk(cli(project, ['generate', '--name', 'cutover', '--cutover', `${fqn}=id`, '--json']), 'generate --cutover')
    expectOk(cli(project, ['migrate', '--apply', '--json']), 'migrate --apply (cutover)')
    const keys = await sortingKeys(target, project)
    if (keys[project.table] !== 'user_id, id') throw new Error(`layouts after the cutover: ${JSON.stringify(keys)}`)
    const [count] = await rows<{ total: number | string }>(target, `SELECT count() AS total FROM ${target.rowsOf(project.table)}`)
    if (Number(count?.total) !== 1000) throw new Error(`the new table must hold the 1000 rows, found ${JSON.stringify(count)}`)
  } finally {
    await dropCutoverProject(target, project)
  }
}

/**
 * The schema declares `columns`, and chkit creates the table from it.
 * ClickHouse stores some types in another spelling (`Decimal64(2)` as
 * `Decimal(18, 2)`), and the cutover must still accept the unchanged table.
 */
export async function runStoredSpellingScenario(target: CutoverTarget, label: string, columns: Array<Record<string, unknown>>): Promise<void> {
  const project = await createCutoverProject(target, label, columns)
  try {
    await writeSchema(target, project, ['user_id', 'id'])
    expectOk(cli(project, ['generate', '--name', 'cutover', '--cutover', `${target.database}.${project.table}=id`, '--json']), 'generate --cutover')
    expectOk(cli(project, ['migrate', '--apply', '--json']), 'migrate --apply (cutover)')
    const keys = await sortingKeys(target, project)
    if (keys[project.table] !== 'user_id, id') throw new Error(`layouts after the cutover: ${JSON.stringify(keys)}`)
    const [count] = await rows<{ total: number | string }>(target, `SELECT count() AS total FROM ${target.rowsOf(project.table)}`)
    if (Number(count?.total) !== project.historic) throw new Error(`the new table must hold the ${project.historic} rows, found ${JSON.stringify(count)}`)
    // No assertChkitClean: chkit drift reports Decimal64(2) against the stored Decimal(18, 2) on its own.
  } finally {
    await dropCutoverProject(target, project)
  }
}

/**
 * Replaces the SQL of operation `step` (0-based) with a statement that fails, keeping its marker lines.
 * The server rejects it before it starts (an unknown identifier): an async step that fails while it
 * runs may have applied writes, so it is never retried without an abandon (#767).
 */
function injectFailure(blocks: string[], step: number): string {
  return blocks
    .map((block, index) => {
      if (index !== step + 1) return block
      const comments = block.split('\n').filter((line) => line.startsWith('--'))
      return [...comments, `SELECT \`injected failure at statement ${step + 1}\`;`].join('\n')
    })
    .join('\n\n')
}
