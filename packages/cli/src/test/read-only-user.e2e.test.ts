import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  CORE_ENTRY,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  quoteIdent,
  runCli,
  type CliResult,
} from './e2e-testkit.js'

const env = getLiveEnv()
// ObsessionDB users have no CREATE USER (or any access-management) grant
// (#430), so the tests that create read-only users run in verify, against the
// local stack, only.
const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'

const SQL =
  "SELECT toUInt64(18446744073709551615) AS u64max, toDecimal128('12345678901234567890.123456789', 9) AS d128, " +
  "[toUInt64(18446744073709551615), 1] AS arr_u64, toNullable(toDecimal64('-12.345', 3)) AS nd, toUInt32(7) AS u32"
const EXACT = {
  u64max: '18446744073709551615',
  d128: '12345678901234567890.123456789',
  arr_u64: ['18446744073709551615', '1'],
  nd: '-12.345',
  u32: 7,
}

interface User {
  name: string
  password: string
}

interface Project {
  dir: string
  table: string
  journalTable: string
  /** Runs the CLI as `user`, against `journalTable` unless another is given. */
  cli(user: User, args: string[], journalTable?: string): CliResult
}

async function createProject(label: string, users: User[]): Promise<Project> {
  const dir = await mkdtemp(join(tmpdir(), `chkit-${label}-`))
  const table = `${createPrefix(label)}events`
  const journalTable = createJournalTableName(label)
  await writeFile(
    join(dir, 'schema.ts'),
    `import { schema, table } from '${CORE_ENTRY}'\n\nexport default schema(table({\n  database: '${env.clickhouseDatabase}',\n  name: '${table}',\n  columns: [{ name: 'id', type: 'UInt64' }, { name: 'amount', type: 'Decimal(18, 4)' }],\n  engine: 'MergeTree()',\n  primaryKey: ['id'],\n  orderBy: ['id'],\n}))\n`,
    'utf8',
  )
  const configPath = (user: User) => join(dir, `${user.name}.config.ts`)
  for (const user of users) {
    await writeFile(
      configPath(user),
      `export default {\n  schema: '${join(dir, 'schema.ts')}',\n  outDir: '${join(dir, 'chkit')}',\n  migrationsDir: '${join(dir, 'chkit/migrations')}',\n  metaDir: '${join(dir, 'chkit/meta')}',\n  clickhouse: {\n    url: '${env.clickhouseUrl}',\n    username: '${user.name}',\n    password: '${user.password}',\n    database: '${env.clickhouseDatabase}',\n  },\n}\n`,
      'utf8',
    )
  }
  return {
    dir,
    table,
    journalTable,
    cli(user, args, journal = journalTable) {
      return runCli(dir, [...args, '--config', configPath(user)], {
        CHKIT_JOURNAL_TABLE: journal,
        CI: '1',
        HOME: dir,
        XDG_CONFIG_HOME: dir,
      })
    },
  }
}

function json(result: CliResult, label: string, exitCode = 0): Record<string, unknown> {
  expect(result.exitCode, formatTestDiagnostic(label, result)).toBe(exitCode)
  return JSON.parse(result.stdout)
}

describe('read-only commands (#402)', () => {
  const admin: User = { name: env.clickhouseUser, password: env.clickhousePassword }

  test('status, check and migrate read a missing journal as empty and do not create it', async () => {
    const executor = createLiveExecutor(env)
    const project = await createProject('ro_missing_journal', [admin])
    try {
      json(project.cli(admin, ['generate', '--name', 'init', '--json']), 'generate')

      expect(json(project.cli(admin, ['status', '--json']), 'status')).toMatchObject({ applied: 0, pending: 1 })
      expect(json(project.cli(admin, ['check', '--json']), 'check', 1).failedChecks).toContain('pending_migrations')
      expect(json(project.cli(admin, ['migrate', '--json']), 'migrate')).toMatchObject({ mode: 'plan' })

      const journals = await executor.query<{ name: string }>(
        `SELECT name FROM system.tables WHERE database = '${env.clickhouseDatabase}' AND name = '${project.journalTable}'`,
      )
      expect(journals).toEqual([])
    } finally {
      await rm(project.dir, { recursive: true, force: true })
      await executor.close()
    }
  }, 120_000)

  for (const readonly of [1, 2]) {
    test.skipIf(onObsessionDB)(
      `a readonly = ${readonly} user runs query, status, check, drift and migrate (plan); migrate --apply fails`,
      async () => {
        const executor = createLiveExecutor(env)
        const user: User = { name: `${createPrefix(`ro${readonly}`)}user`, password: crypto.randomUUID() }
        const project = await createProject(`ro${readonly}`, [admin, user])
        const missingJournal = createJournalTableName(`ro${readonly}_missing`)
        const legacyJournal = createJournalTableName(`ro${readonly}_legacy`)
        try {
          await executor.command(
            `CREATE USER ${quoteIdent(user.name)} IDENTIFIED BY '${user.password}' SETTINGS readonly = ${readonly}`,
          )
          await executor.command(`GRANT SELECT ON *.* TO ${quoteIdent(user.name)}`)
          json(project.cli(admin, ['generate', '--name', 'init', '--json']), 'generate')
          json(project.cli(admin, ['migrate', '--apply', '--json']), 'migrate --apply (admin)')

          const query = json(project.cli(user, ['query', SQL, '--json']), 'query --json')
          expect(query.data).toEqual([EXACT])
          const table = project.cli(user, ['query', SQL])
          expect(table.exitCode, formatTestDiagnostic('query', table)).toBe(0)
          expect(table.stdout.split('\n')[2]?.split('│').map((cell) => cell.trim())).toEqual([
            EXACT.u64max,
            EXACT.d128,
            JSON.stringify(EXACT.arr_u64),
            EXACT.nd,
            '7',
          ])

          expect(json(project.cli(user, ['status', '--json']), 'status')).toMatchObject({ applied: 1, pending: 0 })
          expect(json(project.cli(user, ['check', '--json']), 'check')).toMatchObject({ ok: true, failedChecks: [] })
          expect(json(project.cli(user, ['drift', '--json']), 'drift')).toMatchObject({ drifted: false })
          expect(json(project.cli(user, ['migrate', '--json']), 'migrate')).toMatchObject({ mode: 'plan', pending: [] })

          // A missing journal reads as no applied migrations, and writing one fails
          // with ClickHouse's own error.
          expect(json(project.cli(user, ['status', '--json'], missingJournal), 'status (no journal)')).toMatchObject({
            applied: 0,
            pending: 1,
          })
          const apply = json(project.cli(user, ['migrate', '--apply', '--json'], missingJournal), 'migrate --apply', 1)
          expect(apply).toMatchObject({ ok: false })
          expect(JSON.stringify(apply.error)).toMatch(/readonly mode|Not enough privileges/)
          const journals = await executor.query<{ name: string }>(
            `SELECT name FROM system.tables WHERE database = '${env.clickhouseDatabase}' AND name = '${missingJournal}'`,
          )
          expect(journals).toEqual([])

          // A journal from before per-operation tracking needs an ALTER the user
          // cannot run: say so, instead of a settings error.
          await executor.command(
            `CREATE TABLE ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(legacyJournal)} (name String, applied_at DateTime64(3, 'UTC'), checksum String, chkit_version String) ENGINE = ReplacingMergeTree(applied_at) ORDER BY name`,
          )
          const legacy = project.cli(user, ['status', '--json'], legacyJournal)
          expect(legacy.exitCode, formatTestDiagnostic('status (legacy journal)', legacy)).toBe(1)
          expect(`${legacy.stdout}${legacy.stderr}`).toContain(
            `The journal table ${legacyJournal} predates per-operation tracking and needs its new columns added. Run chkit once as a user that can ALTER it`,
          )
        } finally {
          await rm(project.dir, { recursive: true, force: true })
          await executor.command(`DROP USER IF EXISTS ${quoteIdent(user.name)}`).catch(() => {})
          for (const name of [project.table, project.journalTable, missingJournal, legacyJournal]) {
            await executor
              .command(`DROP TABLE IF EXISTS ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(name)} SYNC`)
              .catch(() => {})
          }
          await executor.close()
        }
      },
      180_000,
    )
  }
})
