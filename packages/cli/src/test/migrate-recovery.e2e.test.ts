import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import { EMPTY_MIGRATIONS_SUMMARY } from '../commands/migrate/errors.js'
import { checksumSQL } from '../runtime/migration-store.js'
import {
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getRequiredEnv,
  quoteIdent,
  runCli,
  waitForColumn,
  waitForRows,
  waitForTable,
  waitForView,
  type CliResult,
} from './e2e-testkit.js'

// Live coverage for recovering a migration that failed part-way (#233):
// --retry with an edited file, --abandon (preview and perform), the automatic
// restart of an edited file once nothing has completed, and the refusal of
// pending files without executable statements.

interface Project {
  dir: string
  configPath: string
  migrationsDir: string
  metaDir: string
  database: string
  journalTable: string
  prefix: string
  executor: ClickHouseExecutor
  cliEnv: Record<string, string>
}

interface JournalRow {
  checksum: string
  completed: number
  statuses: string
}

type ErrorEnvelope = { ok: false; error: { code: string; message: string } }

type AbandonPayload = { abandon: { completedStatements: number; operations: Array<{ lastError: string }> } }

const TIMEOUT_MS = 240_000

describe('@chkit/cli migrate failed-migration recovery e2e (#233)', () => {
  test('--retry resumes an edited migration; a retry that fails again resumes without --retry', async () => {
    const project = await createProject('retry')
    const { database: db, prefix, executor } = project
    const [a, b, c, v] = [`${prefix}a`, `${prefix}b`, `${prefix}c`, `${prefix}v`]
    const M = '20990101000000_recover.sql'
    const v1 = threeStatementMigration({ db, a, v, viewSource: b, b })
    const v2 = threeStatementMigration({ db, a, v, viewSource: c, b })

    try {
      await createTable(executor, db, a)
      await writeMigration(project, M, v1)

      const noState = parseJson<{ retry: unknown }>(migrate(project, ['--json', '--retry', '20990101000000_recover']))
      expect(noState.retry).toEqual({ action: 'none', migration: M, reason: 'not_in_progress' })

      const run1 = migrate(project, ['--execute', '--json'])
      expect(run1.exitCode).toBe(1)
      expect(errorOf(run1).message).toContain(`Migration ${M} failed at statement 2 of 3`)
      await waitForColumn(executor, db, a, 'c1')

      const typo = migrate(project, ['--execute', '--json', '--retry', 'nope'])
      expect(typo.exitCode).toBe(1)
      expect(errorOf(typo).code).toBe('migration_not_found')

      await writeMigration(project, M, v2)
      const refused = migrate(project, ['--execute', '--json'])
      expect(refused.exitCode).toBe(1)
      expect(errorOf(refused).code).toBe('in_progress_checksum_mismatch')
      expect(errorOf(refused).message).toContain(`chkit migrate --apply --retry ${M}`)
      expect(errorOf(refused).message).toContain(`chkit migrate --apply --abandon ${M}`)

      const preview = parseJson<{ mode: string; retry: unknown }>(migrate(project, ['--json', '--retry', M]))
      expect(preview.mode).toBe('plan')
      expect(preview.retry).toEqual({
        action: 'resume',
        migration: M,
        previousChecksum: checksumSQL(v1),
        checksum: checksumSQL(v2),
        totalStatements: 3,
        completedStatements: 1,
        resumeAtStatement: 2,
        unmarkedCompletedStatements: 0,
      })
      // The preview wrote nothing.
      await waitForJournal(project, M, (row) => row.checksum === checksumSQL(v1) && row.completed === 0)
      // A --table selector that matches nothing still reports what --retry did.
      const noMatch = parseJson<{ pending: string[]; warning: string; retry: unknown }>(
        migrate(project, ['--json', '--retry', M, '--table', `${db}.nomatch`]),
      )
      expect(noMatch).toMatchObject({ pending: [], warning: `No tables matched selector "${db}.nomatch".` })
      expect(noMatch.retry).toEqual({ action: 'none', migration: M, reason: 'not_in_scope' })

      // Statement 2 still fails (table c is missing), but statement 1 was skipped:
      // replaying it would fail on the existing column instead.
      const retryRun = migrate(project, ['--execute', '--json', '--retry', `chkit/migrations/${M}`])
      expect(retryRun.exitCode).toBe(1)
      expect(errorOf(retryRun).message).toContain(`Migration ${M} failed at statement 2 of 3`)
      await waitForJournal(project, M, (row) => row.checksum === checksumSQL(v2) && row.completed === 0)

      await createTable(executor, db, c)
      const resumed = migrate(project, ['--execute', '--json'])
      expect(resumed.exitCode, formatTestDiagnostic('resume without --retry', resumed)).toBe(0)
      const applied = parseJson<{ applied: Array<{ name: string; checksum: string }> }>(resumed).applied
      expect(applied.map((entry) => [entry.name, entry.checksum])).toEqual([[M, checksumSQL(v2)]])
      await waitForView(executor, db, v)
      await waitForJournal(
        project,
        M,
        (row) => row.completed === 1 && row.checksum === checksumSQL(v2) && row.statuses === 'completed,completed,completed',
      )

      // The same --retry command in an environment where nothing is pending.
      const done = parseJson<{ mode: string; pending: string[]; applied: unknown[]; retry: unknown }>(
        migrate(project, ['--execute', '--json', '--retry', M]),
      )
      expect(done).toMatchObject({ mode: 'execute', pending: [], applied: [] })
      expect(done.retry).toEqual({ action: 'none', migration: M, reason: 'already_applied' })
      const doneText = migrate(project, ['--retry', M])
      expect(doneText.exitCode, formatTestDiagnostic('--retry with nothing pending', doneText)).toBe(0)
      expect(doneText.stdout).toContain('No pending migrations.')
      expect(doneText.stdout).toContain(`Retry ${M}: already applied; --retry has no effect.`)
    } finally {
      await dropProject(project, { views: [v], tables: [a, b, c] })
    }
  }, TIMEOUT_MS)

  test('--abandon previews, then resets the state so the edited file runs again from statement 1', async () => {
    const project = await createProject('abandon')
    const { database: db, prefix, executor } = project
    const [a, b, v] = [`${prefix}a`, `${prefix}b`, `${prefix}v`]
    const M = '20990101000000_recover.sql'
    const v1 = threeStatementMigration({ db, a, v, viewSource: b, b })
    // Statement 1 moved: --retry must refuse, and the whole file is safe to run twice.
    const v3 = [
      `-- operation: create_table key=table:${db}.${b} risk=safe`,
      `CREATE TABLE IF NOT EXISTS ${db}.${b} (id UInt64) ENGINE = MergeTree ORDER BY id;`,
      '',
      `-- operation: alter_table_add_column key=table:${db}.${a} risk=safe`,
      `ALTER TABLE ${db}.${a} ADD COLUMN IF NOT EXISTS c1 UInt64;`,
      '',
      `-- operation: create_view key=view:${db}.${v} risk=safe`,
      `CREATE VIEW ${db}.${v} AS SELECT id FROM ${db}.${b};`,
      '',
    ].join('\n')

    try {
      await createTable(executor, db, a)
      await writeMigration(project, M, v1)
      const run1 = migrate(project, ['--execute', '--json'])
      expect(run1.exitCode).toBe(1)
      expect(errorOf(run1).message).toContain(`Migration ${M} failed at statement 2 of 3`)
      await waitForColumn(executor, db, a, 'c1')
      await waitForJournal(project, M, (row) => row.statuses === 'completed,failed')

      await writeMigration(project, M, v3)
      const mismatch = migrate(project, ['--execute', '--json', '--retry', M])
      expect(mismatch.exitCode).toBe(1)
      expect(errorOf(mismatch).code).toBe('retry_mismatch')
      expect(errorOf(mismatch).message).toContain('statement 1: completed as alter_table_add_column')
      expect(errorOf(mismatch).message).toContain(`chkit migrate --apply --abandon ${M}`)

      const expectedReport = {
        migration: M,
        checksum: checksumSQL(v1),
        completedStatements: 1,
        operations: [
          expect.objectContaining({ operationIndex: 0, operationType: 'alter_table_add_column', status: 'completed' }),
          expect.objectContaining({ operationIndex: 1, operationType: 'create_view', status: 'failed' }),
        ],
      }
      const preview = parseJson<{ mode: string; abandon: unknown }>(migrate(project, ['--abandon', M, '--json']))
      expect(preview).toMatchObject({ mode: 'plan', abandon: expectedReport })
      await waitForJournal(project, M, (row) => row.checksum === checksumSQL(v1) && row.statuses === 'completed,failed')

      const performed = parseJson<{ mode: string; abandon: unknown }>(
        migrate(project, ['--abandon', M, '--apply', '--json']),
      )
      expect(performed).toMatchObject({ mode: 'execute', abandon: expectedReport })
      await waitForJournal(
        project,
        M,
        (row) => row.checksum === checksumSQL(v1) && row.completed === 0 && row.statuses === 'failed,failed',
      )

      // Abandoning again keeps the record that statement 1 completed: its
      // ALTER stays applied in ClickHouse.
      const wasCompleted = 'abandoned via chkit migrate --abandon (was completed)'
      const again = parseJson<AbandonPayload>(migrate(project, ['--abandon', M, '--apply', '--json']))
      expect(again.abandon.completedStatements).toBe(1)
      expect(again.abandon.operations[0]?.lastError).toBe(wasCompleted)
      const kept = parseJson<AbandonPayload>(migrate(project, ['--abandon', M, '--json']))
      expect(kept.abandon.completedStatements).toBe(1)
      expect(kept.abandon.operations[0]?.lastError).toBe(wasCompleted)

      // Nothing is recorded as completed any more, so the edited file runs
      // again from statement 1 without --retry.
      const rerun = migrate(project, ['--execute', '--json'])
      expect(rerun.exitCode, formatTestDiagnostic('apply after abandon', rerun)).toBe(0)
      expect(rerun.stderr).toContain(
        `${M} changed since its last failed attempt; no statement is recorded as completed, so it runs again from statement 1.`,
      )
      const applied = parseJson<{ applied: Array<{ name: string; checksum: string }> }>(rerun).applied
      expect(applied.map((entry) => [entry.name, entry.checksum])).toEqual([[M, checksumSQL(v3)]])
      await waitForTable(executor, db, b)
      await waitForView(executor, db, v)
      await waitForJournal(
        project,
        M,
        (row) => row.completed === 1 && row.checksum === checksumSQL(v3) && row.statuses === 'completed,completed,completed',
      )

      const applied2 = migrate(project, ['--abandon', M, '--json'])
      expect(applied2.exitCode).toBe(1)
      expect(errorOf(applied2).code).toBe('migration_already_applied')
      const unknown = migrate(project, ['--abandon', '20990101000009_never_ran.sql', '--json'])
      expect(unknown.exitCode).toBe(1)
      expect(errorOf(unknown).code).toBe('migration_not_in_progress')
    } finally {
      await dropProject(project, { views: [v], tables: [a, b] })
    }
  }, TIMEOUT_MS)

  test('--abandon needs neither the migration file nor a parseable snapshot.json', async () => {
    const project = await createProject('abandon_gone')
    const { database: db, prefix, executor } = project
    const [a, b, v] = [`${prefix}a`, `${prefix}b`, `${prefix}v`]
    const M = '20990101000000_gone.sql'

    try {
      await createTable(executor, db, a)
      await writeMigration(project, M, threeStatementMigration({ db, a, v, viewSource: b, b }))
      const run1 = migrate(project, ['--execute', '--json'])
      expect(run1.exitCode).toBe(1)
      expect(errorOf(run1).message).toContain(`Migration ${M} failed at statement 2 of 3`)
      await waitForJournal(project, M, (row) => row.statuses === 'completed,failed')

      await mkdir(project.metaDir, { recursive: true })
      await writeFile(
        join(project.metaDir, 'snapshot.json'),
        '<<<<<<< HEAD\n{"version":1}\n=======\n{"version":1,"definitions":[]}\n>>>>>>> feature\n',
        'utf8',
      )
      await rm(join(project.migrationsDir, M))

      // A plain migrate cannot read the conflicted snapshot.
      const blocked = migrate(project, ['--json'])
      expect(blocked.exitCode).toBe(1)
      expect(errorOf(blocked).message).toContain('contains unresolved merge conflict markers')

      const preview = migrate(project, ['--abandon', M])
      expect(preview.exitCode, formatTestDiagnostic('abandon preview', preview)).toBe(0)
      expect(preview.stdout).toContain('Nothing has changed yet.')
      expect(preview.stdout).toContain('1 completed statement(s) remain applied in ClickHouse:')
      expect(preview.stdout).toContain(`${M} is no longer in the migrations directory`)
      expect(preview.stdout).toContain('Plan only. Re-run with --apply')
      await waitForJournal(project, M, (row) => row.statuses === 'completed,failed')

      const performed = migrate(project, ['--abandon', M, '--apply'])
      expect(performed.exitCode, formatTestDiagnostic('abandon', performed)).toBe(0)
      expect(performed.stdout).toContain(`Abandoned in-progress migration ${M}`)
      await waitForJournal(project, M, (row) => row.completed === 0 && row.statuses === 'failed,failed')
    } finally {
      await dropProject(project, { views: [v], tables: [a, b] })
    }
  }, TIMEOUT_MS)

  test('migrate --apply refuses pending files without executable statements and journals nothing', async () => {
    const project = await createProject('empty_mig')
    const { database: db, prefix, executor } = project
    const t = `${prefix}t`
    const real = '20990101000000_real.sql'
    const stub = '20990101000001_stub.sql'
    const note = '20990101000002_note.sql'

    try {
      await writeMigration(
        project,
        real,
        `CREATE TABLE IF NOT EXISTS ${db}.${t} (id UInt64) ENGINE = MergeTree ORDER BY id;\n`,
      )
      const scaffold = runCli(
        project.dir,
        ['generate', '--config', project.configPath, '--empty', '--name', 'stub', '--migration-id', '20990101000001', '--json'],
        project.cliEnv,
      )
      expect(scaffold.exitCode, formatTestDiagnostic('generate --empty', scaffold)).toBe(0)
      expect(parseJson<{ migrationFile: string }>(scaffold).migrationFile.endsWith(stub)).toBe(true)
      await writeMigration(project, note, '/* backfill goes here */\n')

      const plan = parseJson<{ pending: string[]; emptyMigrations: string[] }>(migrate(project, ['--json']))
      expect(plan.pending).toEqual([real, stub, note])
      expect(plan.emptyMigrations).toEqual([stub, note])
      // An empty file has nothing to resume, so --retry has no effect on it.
      const emptyRetry = parseJson<{ retry?: unknown; emptyMigrations: string[] }>(
        migrate(project, ['--json', '--retry', stub]),
      )
      expect(emptyRetry.retry).toEqual({ action: 'none', migration: stub, reason: 'empty_migration' })
      expect(emptyRetry.emptyMigrations).toEqual([stub, note])

      const blocked = migrate(project, ['--execute', '--json'])
      expect(blocked.exitCode).toBe(1)
      const payload = JSON.parse(blocked.stdout) as Record<string, unknown>
      expect(payload).toMatchObject({ mode: 'execute', error: EMPTY_MIGRATIONS_SUMMARY, emptyMigrations: [stub, note] })
      expect(payload.applied).toBeUndefined()

      const blockedText = migrate(project, ['--execute'])
      expect(blockedText.exitCode).toBe(1)
      expect(blockedText.stderr).toContain('contain no executable statements')
      expect(blockedText.stderr).toContain(stub)

      // Nothing ran and nothing was journaled.
      const tables = await executor.query<{ n: string }>(
        `SELECT toString(count()) AS n FROM system.tables WHERE database = '${db}' AND name = '${t}'`,
      )
      expect(Number(tables[0]?.n)).toBe(0)
      const journal = await executor.query<{ n: string }>(
        `SELECT toString(count()) AS n FROM ${quoteIdent(db)}.${quoteIdent(project.journalTable)} FINAL`,
      )
      expect(Number(journal[0]?.n)).toBe(0)

      // Fill in the stub, drop the note: both remaining files apply.
      await appendFile(join(project.migrationsDir, stub), `INSERT INTO ${db}.${t} VALUES (1);\n`, 'utf8')
      await rm(join(project.migrationsDir, note))
      const applied = migrate(project, ['--execute', '--json'])
      expect(applied.exitCode, formatTestDiagnostic('apply filled stub', applied)).toBe(0)
      expect(parseJson<{ applied: Array<{ name: string }> }>(applied).applied.map((entry) => entry.name)).toEqual([
        real,
        stub,
      ])
      await waitForRows<{ n: string }>(
        executor,
        `SELECT toString(count()) AS n FROM ${quoteIdent(db)}.${quoteIdent(t)}`,
        (rows) => Number(rows[0]?.n) === 1,
        'empty-migration: stub insert visible',
      )
    } finally {
      await dropProject(project, { views: [], tables: [t] })
    }
  }, TIMEOUT_MS)

  // The async query id depends only on (migration, statement index), so the
  // first run's QueryFinish is still in system.query_log after --abandon. An
  // edited load that fails before it starts must not inherit that success.
  // The abandoned load keeps its query id, so its -- before-retry: line runs
  // before every later attempt and the load never adds its rows twice.
  test('an abandoned async load whose edited statement fails before it starts is not journaled as completed', async () => {
    const project = await createProject('abandon_async')
    const { database: db, prefix, executor } = project
    const [src, dst, v] = [`${prefix}src`, `${prefix}dst`, `${prefix}v`]
    // The query id is global on the server: a per-run file name keeps
    // concurrent runs of this test from sharing it.
    const M = `20990101000000_${prefix}load.sql`
    const dstRows = (expected: number, label: string) =>
      waitForRows<{ n: string }>(
        executor,
        `SELECT toString(count()) AS n FROM ${quoteIdent(db)}.${quoteIdent(dst)}`,
        (rows) => Number(rows[0]?.n) === expected,
        label,
      )
    const migration = (loadSource: string, viewSource: string) =>
      [
        `-- operation: load_table_data key=table:${db}.${dst} risk=caution mode=async`,
        `-- before-retry: TRUNCATE TABLE ${db}.${dst}`,
        `INSERT INTO ${db}.${dst} SELECT id FROM ${db}.${loadSource};`,
        '',
        `-- operation: create_view key=view:${db}.${v} risk=safe`,
        `CREATE VIEW ${db}.${v} AS SELECT id FROM ${db}.${viewSource};`,
        '',
      ].join('\n')

    try {
      await createTable(executor, db, src)
      await executor.command(`INSERT INTO ${quoteIdent(db)}.${quoteIdent(src)} VALUES (1), (2)`)
      await createTable(executor, db, dst)

      await writeMigration(project, M, migration(src, `${prefix}missing`))
      const run1 = migrate(project, ['--execute', '--json'])
      expect(run1.exitCode).toBe(1)
      // Async progress goes to stderr, so stdout holds only the JSON envelope.
      expect(errorOf(run1).message).toContain(`Migration ${M} failed at statement 2 of 2`)
      expect(run1.stderr).toContain('load_table_data: finished')
      await waitForJournal(project, M, (row) => row.statuses === 'completed,failed')
      await dstRows(2, 'abandon-async: first load visible')

      const abandoned = migrate(project, ['--abandon', M, '--apply', '--json'])
      expect(abandoned.exitCode, formatTestDiagnostic('abandon', abandoned)).toBe(0)
      await waitForJournal(project, M, (row) => row.statuses === 'failed,failed')

      await writeMigration(project, M, migration(`${src}_typo`, src))
      const run2 = migrate(project, ['--execute', '--json'])
      expect(run2.exitCode, formatTestDiagnostic('edited load', run2)).toBe(1)
      expect(errorOf(run2).message).toContain(`Migration ${M} failed at statement 1 of 2`)
      expect(errorOf(run2).message).toContain(`${src}_typo`)
      await waitForJournal(project, M, (row) => row.completed === 0 && row.statuses === 'failed,failed')
      // The abandoned load took the retry path: its -- before-retry: line
      // emptied the table before the edited load failed.
      expect(run2.stderr).toContain('load_table_data: running before-retry SQL')
      await dstRows(0, 'abandon-async: before-retry emptied the table')
      const views = await executor.query<{ n: string }>(
        `SELECT toString(count()) AS n FROM system.tables WHERE database = '${db}' AND name = '${v}'`,
      )
      expect(Number(views[0]?.n)).toBe(0)

      // Nothing completed, so the fixed file runs again without --retry.
      await writeMigration(project, M, migration(src, src))
      const run3 = migrate(project, ['--execute', '--json'])
      expect(run3.exitCode, formatTestDiagnostic('fixed load', run3)).toBe(0)
      await waitForView(executor, db, v)
      await waitForJournal(project, M, (row) => row.completed === 1 && row.statuses === 'completed,completed')
      await dstRows(2, 'abandon-async: the fixed load added its rows once')
    } finally {
      await dropProject(project, { views: [v], tables: [src, dst] })
    }
  }, TIMEOUT_MS)
})

async function createProject(label: string): Promise<Project> {
  const liveEnv = getRequiredEnv()
  const dir = await mkdtemp(join(tmpdir(), `chkit-${label}-e2e-`))
  const migrationsDir = join(dir, 'chkit/migrations')
  const metaDir = join(dir, 'chkit/meta')
  const configPath = join(dir, 'clickhouse.config.ts')
  await mkdir(migrationsDir, { recursive: true })
  await writeFile(
    configPath,
    `export default {\n` +
      `  schema: '${join(dir, 'schema.ts')}',\n` +
      `  outDir: '${join(dir, 'chkit')}',\n` +
      `  migrationsDir: '${migrationsDir}',\n` +
      `  metaDir: '${metaDir}',\n` +
      `  clickhouse: {\n` +
      `    url: '${liveEnv.clickhouseUrl}',\n` +
      `    username: '${liveEnv.clickhouseUser}',\n` +
      `    password: '${liveEnv.clickhousePassword}',\n` +
      `    database: '${liveEnv.clickhouseDatabase}',\n` +
      `  },\n}\n`,
    'utf8',
  )
  const journalTable = createJournalTableName(label)
  return {
    dir,
    configPath,
    migrationsDir,
    metaDir,
    database: liveEnv.clickhouseDatabase,
    journalTable,
    prefix: createPrefix(label),
    executor: createLiveExecutor(liveEnv),
    cliEnv: { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' },
  }
}

async function dropProject(project: Project, objects: { views: string[]; tables: string[] }): Promise<void> {
  const { executor, database } = project
  for (const view of objects.views) {
    await executor.command(`DROP VIEW IF EXISTS ${quoteIdent(database)}.${quoteIdent(view)}`)
  }
  for (const table of [...objects.tables, project.journalTable]) {
    await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(table)}`)
  }
  await executor.close()
  await rm(project.dir, { recursive: true, force: true })
}

function migrate(project: Project, args: string[]): CliResult {
  return runCli(project.dir, ['migrate', '--config', project.configPath, ...args], project.cliEnv)
}

// Statement 1 is not idempotent, so a replay fails with "already exists";
// statement 2 fails until `viewSource` exists.
function threeStatementMigration(input: { db: string; a: string; v: string; viewSource: string; b: string }): string {
  const { db, a, v, viewSource, b } = input
  return [
    `-- operation: alter_table_add_column key=table:${db}.${a} risk=safe`,
    `ALTER TABLE ${db}.${a} ADD COLUMN c1 UInt64;`,
    '',
    `-- operation: create_view key=view:${db}.${v} risk=safe`,
    `CREATE VIEW ${db}.${v} AS SELECT id FROM ${db}.${viewSource};`,
    '',
    `-- operation: create_table key=table:${db}.${b} risk=safe`,
    `CREATE TABLE ${db}.${b} (id UInt64) ENGINE = MergeTree ORDER BY id;`,
    '',
  ].join('\n')
}

async function writeMigration(project: Project, name: string, sql: string): Promise<void> {
  await writeFile(join(project.migrationsDir, name), sql, 'utf8')
}

async function createTable(executor: ClickHouseExecutor, database: string, table: string): Promise<void> {
  await executor.command(
    `CREATE TABLE ${quoteIdent(database)}.${quoteIdent(table)} (id UInt64) ENGINE = MergeTree ORDER BY id`,
  )
  await waitForTable(executor, database, table)
}

// The journal is a ReplacingMergeTree read with FINAL; poll until the newest
// version is visible (writes race propagation on managed ClickHouse).
async function waitForJournal(
  project: Project,
  migration: string,
  predicate: (row: JournalRow) => boolean,
): Promise<JournalRow> {
  const rows = await waitForRows<{ checksum: string; completed: string; statuses: string }>(
    project.executor,
    `SELECT checksum, toString(toUInt8(migration_completed)) AS completed, ` +
      `arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses ` +
      `FROM ${quoteIdent(project.database)}.${quoteIdent(project.journalTable)} FINAL ` +
      `WHERE name = '${migration}' SETTINGS select_sequential_consistency = 1`,
    (found) => {
      const row = found[0]
      return row !== undefined && predicate(toJournalRow(row))
    },
    `journal state of ${migration}`,
  )
  const row = rows[0]
  expect(row).toBeDefined()
  return toJournalRow(row ?? { checksum: '', completed: '0', statuses: '' })
}

function toJournalRow(row: { checksum: string; completed: string; statuses: string }): JournalRow {
  return { checksum: row.checksum, completed: Number(row.completed), statuses: row.statuses }
}

function parseJson<T>(result: CliResult): T {
  expect(result.exitCode, formatTestDiagnostic('expected a successful --json run', result)).toBe(0)
  return JSON.parse(result.stdout) as T
}

function errorOf(result: CliResult): ErrorEnvelope['error'] {
  const envelope = JSON.parse(result.stdout) as ErrorEnvelope
  expect(envelope.ok).toBe(false)
  return envelope.error
}
