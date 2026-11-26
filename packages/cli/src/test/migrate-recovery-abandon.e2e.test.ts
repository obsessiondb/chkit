import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { checksumSQL } from '../runtime/migration-store.js'
import {
  formatTestDiagnostic,
  quoteIdent,
  waitForColumn,
  waitForRows,
  waitForTable,
  waitForView,
} from './e2e-testkit.js'
import {
  type AbandonPayload,
  TIMEOUT_MS,
  createProject,
  createTable,
  dropProject,
  errorOf,
  migrate,
  parseJson,
  threeStatementMigration,
  waitForJournal,
  writeMigration,
} from './migrate-recovery-project.js'

// Live coverage for --abandon of a migration that failed part-way (#233):
// the preview and the reset, without the migration file, and of an async load.

describe('@chkit/cli migrate failed-migration recovery e2e (#233)', () => {
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
