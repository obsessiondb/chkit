import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import {
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  quoteIdent,
  runCli,
  waitForRows,
  waitForTable,
  type CliResult,
} from './e2e-testkit.js'

export interface Project {
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

export interface JournalRow {
  checksum: string
  completed: number
  statuses: string
}

export type ErrorEnvelope = { ok: false; error: { code: string; message: string } }

export type AbandonPayload = { abandon: { completedStatements: number; operations: Array<{ lastError: string }> } }

export const TIMEOUT_MS = 240_000

export const OLD_OPERATIONS_TYPE =
  "Array(Tuple(operation_index Int32, operation_key String, operation_type String, query_id String, status LowCardinality(String), started_at DateTime64(3, 'UTC'), finished_at Nullable(DateTime64(3, 'UTC')), last_error String))"

export async function createProject(label: string): Promise<Project> {
  const liveEnv = getLiveEnv()
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

export async function dropProject(project: Project, objects: { views: string[]; tables: string[] }): Promise<void> {
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

export function migrate(project: Project, args: string[]): CliResult {
  return runCli(project.dir, ['migrate', '--config', project.configPath, ...args], project.cliEnv)
}

// Statement 1 is not idempotent, so a replay fails with "already exists";
// statement 2 fails until `viewSource` exists.
export function threeStatementMigration(input: { db: string; a: string; v: string; viewSource: string; b: string }): string {
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

export async function writeMigration(project: Project, name: string, sql: string): Promise<void> {
  await writeFile(join(project.migrationsDir, name), sql, 'utf8')
}

export async function createTable(executor: ClickHouseExecutor, database: string, table: string): Promise<void> {
  await executor.command(
    `CREATE TABLE ${quoteIdent(database)}.${quoteIdent(table)} (id UInt64) ENGINE = MergeTree ORDER BY id`,
  )
  await waitForTable(executor, database, table)
}

// The journal is a ReplacingMergeTree read with FINAL; poll until the newest
// version is visible (writes race propagation on managed ClickHouse).
export async function waitForJournal(
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

// Writes the next version of a migration's row as a release that records
// `0.0.1-old` would, with unmarked statements of the given statuses.
export async function recordOldReleaseState(project: Project, migration: string, statuses: string[]): Promise<void> {
  const journal = `${quoteIdent(project.database)}.${quoteIdent(project.journalTable)}`
  const operations = statuses
    .map(
      (status, index) =>
        `(${index}, 'statement:${index}', 'sql_statement', '', '${status}', applied_at, applied_at, '${status === 'failed' ? 'boom' : ''}')`,
    )
    .join(', ')
  await project.executor.command(
    `INSERT INTO ${journal} (name, applied_at, checksum, chkit_version, migration_completed, operations) ` +
      `SELECT name, applied_at + toIntervalMillisecond(1), checksum, '0.0.1-old', false, [${operations}] ` +
      `FROM ${journal} FINAL WHERE name = '${migration}' SETTINGS select_sequential_consistency = 1`,
  )
}

// The journal row with how many of its operations carry a fingerprint (#599).
export async function waitForFingerprints(
  project: Project,
  migration: string,
  predicate: (row: JournalRow & { fingerprints: number }) => boolean,
): Promise<void> {
  await waitForRows<{ completed: string; statuses: string; fingerprints: string }>(
    project.executor,
    `SELECT toString(toUInt8(migration_completed)) AS completed, ` +
      `arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses, ` +
      `toString(if(length(operation_fingerprints) = length(operations), arrayCount(f -> f != '', operation_fingerprints), 0)) AS fingerprints ` +
      `FROM ${quoteIdent(project.database)}.${quoteIdent(project.journalTable)} FINAL ` +
      `WHERE name = '${migration}' SETTINGS select_sequential_consistency = 1`,
    (found) => {
      const row = found[0]
      return (
        row !== undefined &&
        predicate({
          checksum: '',
          completed: Number(row.completed),
          statuses: row.statuses,
          fingerprints: Number(row.fingerprints),
        })
      )
    },
    `fingerprints of ${migration}`,
  )
}

export function toJournalRow(row: { checksum: string; completed: string; statuses: string }): JournalRow {
  return { checksum: row.checksum, completed: Number(row.completed), statuses: row.statuses }
}

export function parseJson<T>(result: CliResult): T {
  expect(result.exitCode, formatTestDiagnostic('expected a successful --json run', result)).toBe(0)
  return JSON.parse(result.stdout) as T
}

export function errorOf(result: CliResult): ErrorEnvelope['error'] {
  const envelope = JSON.parse(result.stdout) as ErrorEnvelope
  expect(envelope.ok).toBe(false)
  return envelope.error
}
