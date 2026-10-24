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

import { isoWithoutZone } from '../commands/migrate/async-apply.js'
import { createJournalStore, type MigrationRowState } from '../runtime/journal-store.js'
import { CORE_ENTRY, createJournalTableName, createPrefix, formatTestDiagnostic, runCli, type CliResult } from './e2e-testkit.js'

const WORKSPACE_ROOT = join(import.meta.dir, '../../../..')
const CLI_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/src/bin/chkit.ts')
const BACKFILL_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-backfill/src/index.ts')
const HISTORIC_ROWS = 20_000
const BATCH_ROWS = 200
const MIGRATE_TIMEOUT_MS = 600_000

export interface CutoverTarget {
  database: string
  connection: { url: string; username: string; password: string; database: string; cluster?: string }
  /** Runs DDL and verification reads. */
  admin: ClickHouseExecutor
  /** Stateless executors the concurrent writers insert through, round robin. */
  writers: ClickHouseExecutor[]
  engine: string
  /** Every row of a table across shards: a qualified name, or cluster(...). */
  rowsOf: (table: string) => string
  /** Appended to verification reads, e.g. select_sequential_consistency on ObsessionDB. */
  readSettings: string
  /** Runs before verification reads, e.g. syncing the replicas of a cluster. */
  settle?: (tables: string[]) => Promise<void>
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
}

export interface WriterReport {
  batches: number
  rows: number
  errors: string[]
}

export async function createCutoverProject(target: CutoverTarget, label: string): Promise<CutoverProject> {
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
  const [first, second] = [target.writers[0], target.writers[target.writers.length - 1]] as ClickHouseExecutor[]
  await first.command(`INSERT INTO ${db}.${project.table} (id, user_id, payload) SELECT number, number % 97, 'historic' FROM numbers(${half})`)
  await second.command(`INSERT INTO ${db}.${project.ingest} (id, user_id, payload) SELECT ${half} + number, number % 97, 'historic' FROM numbers(${half})`)
  return project
}

/** Rewrites the schema so the table sorts by `orderBy`. */
export async function writeSchema(target: CutoverTarget, project: CutoverProject, orderBy: string[]): Promise<void> {
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

export default schema(
  table({ database: '${db}', name: '${project.table}', engine: ${engine}, columns, primaryKey: ${JSON.stringify(orderBy)}, orderBy: ${JSON.stringify(orderBy)} }),
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
 * Only batches that succeeded count.
 */
export function startWriters(target: CutoverTarget, project: CutoverProject, parallel = 2): { stop: () => Promise<WriterReport> } {
  let stopped = false
  let next = 0
  const report: WriterReport = { batches: 0, rows: 0, errors: [] }
  const db = target.database
  const loop = async (worker: number) => {
    while (!stopped) {
      const batch = next
      next += 1
      const executor = target.writers[batch % target.writers.length] as ClickHouseExecutor
      const into = batch % 2 === 0 ? project.table : project.ingest
      const start = 1_000_000_000 + batch * BATCH_ROWS
      try {
        await executor.command(
          `INSERT INTO ${db}.${into} (id, user_id, payload) SELECT ${start} + number, number % 97, 'live-${worker}' FROM numbers(${BATCH_ROWS})`,
        )
        report.batches += 1
        report.rows += BATCH_ROWS
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
export async function cliAsync(project: CutoverProject, args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(['bun', CLI_ENTRY, ...args, '--config', project.configPath], {
    cwd: project.dir,
    env: { ...process.env, ...project.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill(), MIGRATE_TIMEOUT_MS)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { exitCode, stdout, stderr }
}

export function expectOk(result: CliResult, label: string): CliResult {
  if (result.exitCode !== 0) throw new Error(formatTestDiagnostic(label, result))
  return result
}

/** The cutover migration's file name (generated with --name cutover; init may share its timestamp). */
export async function cutoverMigration(project: CutoverProject): Promise<string> {
  const files = (await readdir(join(project.dir, 'chkit/migrations'))).filter((file) => file.endsWith('_cutover.sql'))
  if (files.length !== 1) throw new Error(`expected one cutover migration, found ${files.join(', ')}`)
  return files[0] as string
}

export async function readMigration(project: CutoverProject, file: string): Promise<string> {
  return readFile(join(project.dir, 'chkit/migrations', file), 'utf8')
}

export async function rows<T>(target: CutoverTarget, sql: string): Promise<T[]> {
  return target.admin.query<T>(`${sql}${target.readSettings}`)
}

/**
 * Asserts the table holds the historic rows and every row a writer inserted,
 * each exactly once, that the view reading from it saw each of them exactly
 * once, and that its layout is `orderBy`.
 */
export async function assertCutoverRows(
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

export async function sortingKeys(target: CutoverTarget, project: CutoverProject): Promise<Record<string, string>> {
  const result = await target.admin.query<{ name: string; sorting_key: string }>(
    `SELECT name, sorting_key FROM system.tables WHERE database = '${target.database}' AND (name IN ('${project.table}', '${project.previous}') OR startsWith(name, '${project.table}__cutover_')) ORDER BY name`,
  )
  return Object.fromEntries(result.map((row) => [row.name, row.sorting_key.replace(/^\(|\)$/g, '')]))
}

/** status, drift, check and generate --dryrun report nothing to do. */
export function assertChkitClean(project: CutoverProject): void {
  const status = JSON.parse(expectOk(cli(project, ['status', '--json']), 'status').stdout) as { pending: number }
  const drift = JSON.parse(expectOk(cli(project, ['drift', '--json']), 'drift').stdout) as {
    drifted: boolean
    missing: string[]
    tableDrift: Array<{ table: string; reasonCodes: string[] }>
  }
  const check = cli(project, ['check', '--json'])
  const plan = JSON.parse(expectOk(cli(project, ['generate', '--dryrun', '--json']), 'generate --dryrun').stdout) as { operationCount: number }
  const summary = {
    pending: status.pending,
    drifted: drift.drifted,
    missing: drift.missing,
    tableDrift: drift.tableDrift.map((table) => `${table.table}: ${table.reasonCodes.join(', ')}`),
    check: check.exitCode,
    operations: plan.operationCount,
  }
  if (JSON.stringify(summary) !== JSON.stringify({ pending: 0, drifted: false, missing: [], tableDrift: [], check: 0, operations: 0 })) {
    throw new Error(`chkit not clean after the cutover: ${JSON.stringify(summary)}\n${formatTestDiagnostic('check', check)}`)
  }
}

/** Reads and rewrites the cutover migration's journal state, e.g. to simulate a lost acknowledgement. */
export async function editJournalState(
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
export async function runKeepScenario(target: CutoverTarget, label: string): Promise<void> {
  const project = await createCutoverProject(target, label)
  try {
    await writeSchema(target, project, ['user_id', 'id'])
    const generated = JSON.parse(
      expectOk(cli(project, ['generate', '--name', 'cutover', '--cutover', `${target.database}.${project.table}=id`, '--json']), 'generate --cutover').stdout,
    ) as { riskSummary: { danger: number }; cutovers: Array<{ retainedAs: string }> }
    if (generated.riskSummary.danger !== 0) throw new Error('a keep-mode cutover must not be destructive')
    if (generated.cutovers[0]?.retainedAs !== `${target.database}.${project.previous}`) throw new Error('missing retained table')

    const writers = startWriters(target, project, 4)
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
    assertChkitClean(project)
  } finally {
    await dropCutoverProject(target, project)
  }
}

/**
 * The backfill copy: the migration stops at the copy check, the backfill
 * plugin copies the snapshot, and the next apply verifies and swaps. The old
 * table is dropped.
 */
export async function runBackfillScenario(target: CutoverTarget, label: string): Promise<void> {
  const project = await createCutoverProject(target, label)
  try {
    await writeSchema(target, project, ['user_id', 'id'])
    const fqn = `${target.database}.${project.table}`
    expectOk(
      cli(project, ['generate', '--name', 'cutover', '--cutover', `${fqn}=id`, '--cutover-copy', 'backfill', '--cutover-old', 'drop', '--json']),
      'generate --cutover backfill',
    )
    const writers = startWriters(target, project)
    const copied = (async () => {
      const stopped = await cliAsync(project, ['migrate', '--apply', '--allow-destructive', '--json'])
      if (stopped.exitCode !== 1 || !`${stopped.stdout}${stopped.stderr}`.includes(`chkit plugin backfill plan --cutover ${fqn}`)) {
        throw new Error(formatTestDiagnostic('migrate must stop at the copy check', stopped))
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
    assertChkitClean(project)
  } finally {
    await dropCutoverProject(target, project)
  }
}

/**
 * Fails every statement of the cutover once and resumes it with --retry, and
 * replays the statements whose acknowledgement can be lost: the snapshot
 * (re-taken after a TRUNCATE), the copy (skips what it wrote), the EXCHANGE
 * (refuses: it must never swap back) and the drop of the old table. Writers
 * insert the whole time; no row may be lost or duplicated.
 */
export async function runRetryScenario(target: CutoverTarget, label: string): Promise<void> {
  const project = await createCutoverProject(target, label)
  const writers = startWriters(target, project, 1)
  let stopped: WriterReport | undefined
  try {
    await writeSchema(target, project, ['user_id', 'id'])
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
      [types.indexOf('cutover_attach'), 'replays'],
      [dropOld, 'replays'],
    ])
    const migrate = (retry: boolean) =>
      cliAsync(project, ['migrate', '--apply', '--allow-destructive', '--json', ...(retry ? ['--retry', file] : [])])
    const write = (content: string) => writeFile(join(project.dir, 'chkit/migrations', file), content, 'utf8')

    for (let step = 0; step < types.length; step += 1) {
      await write(injectFailure(blocks, step))
      const failed = await migrate(step > 0)
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
      if (lost === 'refuses') {
        await write(injectFailure(blocks, step + 1))
        const refused = await migrate(true)
        if (refused.exitCode === 0 || !`${refused.stdout}${refused.stderr}`.includes('the EXCHANGE may already have run')) {
          throw new Error(formatTestDiagnostic('a replayed EXCHANGE must be refused', refused))
        }
        const keys = await sortingKeys(target, project)
        if (keys[project.table] !== 'user_id, id') throw new Error(`the refused replay swapped the tables back: ${JSON.stringify(keys)}`)
        // Documented recovery: the swap ran, so the statement becomes a no-op.
        blocks[step] = (blocks[step] as string)
          .split('\n')
          .filter((line) => !line.startsWith('-- before-retry:'))
          .map((line) => (line.startsWith('EXCHANGE TABLES') ? 'SELECT 1;' : line))
          .join('\n')
      }
    }
    await write(blocks.join('\n\n'))
    expectOk(await migrate(true), 'migrate --apply --retry (complete)')
    stopped = await writers.stop()
    if (stopped.errors.length > 0) throw new Error(`writers failed during the cutover: ${stopped.errors[0]}`)
    await assertCutoverRows(target, project, stopped)
    const keys = await sortingKeys(target, project)
    if (JSON.stringify(keys) !== JSON.stringify({ [project.table]: 'user_id, id' })) {
      throw new Error(`only the cut-over table may remain, found ${JSON.stringify(keys)}`)
    }
    assertChkitClean(project)
  } finally {
    if (!stopped) await writers.stop()
    await dropCutoverProject(target, project)
  }
}

/** Replaces the SQL of operation `step` (0-based) with a statement that fails, keeping its marker lines. */
function injectFailure(blocks: string[], step: number): string {
  return blocks
    .map((block, index) => {
      if (index !== step + 1) return block
      const comments = block.split('\n').filter((line) => line.startsWith('--'))
      return [...comments, `SELECT throwIf(1, 'injected failure at statement ${step + 1}');`].join('\n')
    })
    .join('\n\n')
}
