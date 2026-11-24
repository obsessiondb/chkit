import { appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { EMPTY_MIGRATIONS_SUMMARY } from '../commands/migrate/errors.js'
import { checksumSQL } from '../runtime/migration-store.js'
import {
  formatTestDiagnostic,
  quoteIdent,
  runCli,
  waitForColumn,
  waitForRows,
  waitForTable,
  waitForTableAbsent,
  waitForView,
} from './e2e-testkit.js'
import {
  OLD_OPERATIONS_TYPE,
  TIMEOUT_MS,
  createProject,
  createTable,
  dropProject,
  errorOf,
  migrate,
  parseJson,
  recordOldReleaseState,
  threeStatementMigration,
  waitForFingerprints,
  waitForJournal,
  writeMigration,
} from './migrate-recovery-project.js'

// Live coverage for recovering a migration that failed part-way (#233):
// --retry with an edited file, a resume across releases, and the refusal of
// pending files without executable statements. --abandon is in
// migrate-recovery-abandon.e2e.test.ts.

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
        positionOnlyCompletedStatements: 0,
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

  // Releases before #562 cut at the `;` inside the `//` comment: for them this
  // file was [CREATE a, ALTER a ADD x, CREATE b]; ClickHouse reads [CREATE a, CREATE b].
  test('refuses to resume a partial run that another release split differently, until --abandon (#562)', async () => {
    const project = await createProject('split')
    const { database: db, prefix, executor } = project
    const [a, b] = [`${prefix}a`, `${prefix}b`]
    const M = '20990101000000_split.sql'
    const sql = [
      `CREATE TABLE IF NOT EXISTS ${db}.${a} (id UInt64) ENGINE = MergeTree ORDER BY id // keep; ALTER TABLE ${db}.${a} ADD COLUMN x UInt64`,
      ';',
      `CREATE TABLE ${db}.${b} (id UInt64) ENGINE = MergeTree ORDER BY id;`,
      '',
    ].join('\n')

    try {
      await createTable(executor, db, b)
      await writeMigration(project, M, sql)
      const run1 = migrate(project, ['--execute', '--json'])
      expect(run1.exitCode).toBe(1)
      expect(errorOf(run1).message).toContain(`Migration ${M} failed at statement 2 of 2`)
      await waitForJournal(project, M, (row) => row.statuses === 'completed,failed')

      // A state this release recorded resumes: statement 1 is skipped.
      const run2 = migrate(project, ['--execute', '--json'])
      expect(run2.exitCode).toBe(1)
      expect(errorOf(run2).message).toContain(`Migration ${M} failed at statement 2 of 2`)

      // An older release's state with nothing completed resumes. The run writes
      // the state as this release, so after another failure it resumes again.
      await recordOldReleaseState(project, M, ['failed'])
      await waitForJournal(project, M, (row) => row.statuses === 'failed')
      const run3 = migrate(project, ['--execute', '--json'])
      expect(errorOf(run3).message).toContain(`Migration ${M} failed at statement 2 of 2`)
      await waitForJournal(project, M, (row) => row.statuses === 'completed,failed')
      const run4 = migrate(project, ['--execute', '--json'])
      expect(errorOf(run4).message).toContain(`Migration ${M} failed at statement 2 of 2`)

      // The state an older release would have left: it ran the CREATE and the
      // commented-out ALTER, then CREATE b failed.
      await recordOldReleaseState(project, M, ['completed', 'completed', 'failed'])
      await waitForJournal(project, M, (row) => row.statuses === 'completed,completed,failed')
      const refused = migrate(project, ['--execute', '--json'])
      expect(refused.exitCode).toBe(1)
      expect(errorOf(refused).code).toBe('statement_split_changed')
      expect(errorOf(refused).message).toContain(
        `Cannot resume ${M}: chkit 0.0.1-old recorded its partial run`,
      )
      expect(errorOf(refused).message).toContain('The journal recorded statements 1, 2 as completed or started')
      expect(errorOf(refused).message).toContain(`chkit migrate --apply --abandon ${M}`)
      await waitForJournal(project, M, (row) => row.statuses === 'completed,completed,failed')

      parseJson(migrate(project, ['--abandon', M, '--apply', '--json']))
      await executor.command(`DROP TABLE ${quoteIdent(db)}.${quoteIdent(b)}`)
      // The next request may land on a replica that has not dropped b yet,
      // where the rerun's CREATE TABLE b would fail.
      await waitForTableAbsent(executor, db, b)
      const rerun = migrate(project, ['--execute', '--json'])
      expect(rerun.exitCode, formatTestDiagnostic('apply after abandon', rerun)).toBe(0)
      await waitForTable(executor, db, b)
      await waitForJournal(project, M, (row) => row.completed === 1 && row.statuses === 'completed,completed,failed')
    } finally {
      await dropProject(project, { views: [], tables: [a, b] })
    }
  }, TIMEOUT_MS)

  test('--retry resumes a comment-only edit at the statements that never ran, and refuses an SQL edit to a completed one (#599)', async () => {
    const project = await createProject('fingerprint')
    const { database: db, prefix, executor } = project
    const [a, b, c, d] = [`${prefix}a`, `${prefix}b`, `${prefix}c`, `${prefix}d`]
    const M = '20990101000000_fingerprint.sql'
    const create = (table: string, order = 'id') =>
      `CREATE TABLE ${db}.${table} (id UInt64) ENGINE = MergeTree ORDER BY ${order};`
    const v1 = [create(a), create(b), create(c, 'missing_col'), create(d)].join('\n')

    try {
      await writeMigration(project, M, v1)
      const run1 = migrate(project, ['--execute', '--json'])
      expect(run1.exitCode).toBe(1)
      expect(errorOf(run1).message).toContain(`Migration ${M} failed at statement 3 of 4`)
      await waitForFingerprints(project, M, (row) => row.statuses === 'completed,completed,failed' && row.fingerprints === 3)

      // The completed statement 2 was removed and statement 3 fixed: by
      // position, the fixed statement would be skipped as completed.
      await writeMigration(project, M, [create(a), create(c), create(d)].join('\n'))
      const refused = migrate(project, ['--execute', '--json', '--retry', M])
      expect(refused.exitCode).toBe(1)
      expect(errorOf(refused).code).toBe('retry_mismatch')
      expect(errorOf(refused).message).toContain(
        'statement 2: completed as sql_statement statement:1, but the edited file has different SQL there',
      )
      await waitForJournal(project, M, (row) => row.checksum === checksumSQL(v1) && row.completed === 0)

      // Comments and whitespace changed, and the failed statement was fixed.
      // Statements 1 and 2 are not idempotent: running them again would fail.
      const v3 = [
        '-- the first table',
        create(a).replace('ENGINE', '/* the engine */ ENGINE'),
        `  ${create(b).replace(';', ' // b; still the comment\n;')}`,
        create(c),
        create(d),
      ].join('\n')
      await writeMigration(project, M, v3)
      const resumed = migrate(project, ['--execute', '--json', '--retry', M])
      expect(resumed.exitCode, formatTestDiagnostic('--retry after a comment-only edit', resumed)).toBe(0)
      expect(parseJson<{ retry: unknown }>(resumed).retry).toMatchObject({
        action: 'resume',
        completedStatements: 2,
        resumeAtStatement: 3,
      })
      await waitForTable(executor, db, c)
      await waitForTable(executor, db, d)
      await waitForFingerprints(
        project,
        M,
        (row) => row.completed === 1 && row.statuses === 'completed,completed,completed,completed' && row.fingerprints === 4,
      )
    } finally {
      await dropProject(project, { views: [], tables: [a, b, c, d] })
    }
  }, TIMEOUT_MS)

  test('a journal an older release created gets the fingerprint column; a state an older release wrote resumes by position (#599)', async () => {
    const project = await createProject('fp_old')
    const { database: db, prefix, executor } = project
    const [a, b, c, d] = [`${prefix}a`, `${prefix}b`, `${prefix}c`, `${prefix}d`]
    const M = '20990101000000_fp_old.sql'
    const create = (table: string, order = 'id') =>
      `CREATE TABLE ${db}.${table} (id UInt64) ENGINE = MergeTree ORDER BY ${order};`

    try {
      // The journal as releases before #599 create it.
      await executor.command(
        `CREATE TABLE ${quoteIdent(db)}.${quoteIdent(project.journalTable)} (name String, applied_at DateTime64(3, 'UTC'), checksum String, chkit_version String, migration_completed Bool DEFAULT true, operations ${OLD_OPERATIONS_TYPE} DEFAULT []) ENGINE = ReplacingMergeTree(applied_at) ORDER BY (name) SETTINGS index_granularity = 1`,
      )
      await waitForTable(executor, db, project.journalTable)
      await writeMigration(project, M, [create(a), create(b), create(c, 'missing_col'), create(d)].join('\n'))
      const run1 = migrate(project, ['--execute', '--json'])
      expect(run1.exitCode).toBe(1)
      expect(errorOf(run1).message).toContain(`Migration ${M} failed at statement 3 of 4`)
      await waitForColumn(executor, db, project.journalTable, 'operation_fingerprints')
      await waitForFingerprints(project, M, (row) => row.statuses === 'completed,completed,failed' && row.fingerprints === 3)

      // An older release writes the row without the column: no fingerprints.
      await recordOldReleaseState(project, M, ['completed', 'completed', 'failed'])
      await waitForFingerprints(project, M, (row) => row.statuses === 'completed,completed,failed' && row.fingerprints === 0)

      await writeMigration(
        project,
        M,
        ['-- edited', create(a), `${create(b)} -- b`, create(c), create(d)].join('\n'),
      )
      const resumed = migrate(project, ['--execute', '--json', '--retry', M])
      expect(resumed.exitCode, formatTestDiagnostic('--retry of an older release state', resumed)).toBe(0)
      await waitForTable(executor, db, c)
      await waitForTable(executor, db, d)
      await waitForJournal(project, M, (row) => row.completed === 1)
    } finally {
      await dropProject(project, { views: [], tables: [a, b, c, d] })
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
      // A read does not create the journal (#402), so there is none yet.
      const journal = await executor.query<{ n: string }>(
        `SELECT toString(count()) AS n FROM system.tables WHERE database = '${db}' AND name = '${project.journalTable}'`,
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
})
