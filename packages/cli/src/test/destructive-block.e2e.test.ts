import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  getLiveEnv,
  quoteIdent,
  runCli,
  waitForColumn,
} from './e2e-testkit.js'

describe('@chkit/cli destructive block e2e (#2)', () => {
  test('a hand-written DROP COLUMN with no markers is blocked, not silently applied', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('destructive')
    const table = `${createPrefix('destructive')}users`
    const dir = await mkdtemp(join(tmpdir(), 'chkit-destructive-e2e-'))
    const { migrationsDir, configPath } = projectPaths(dir)

    try {
      await writeProject(dir, liveEnv)

      await executor.command(
        `CREATE TABLE ${quoteIdent(database)}.${quoteIdent(table)} (id UInt64, email String) ENGINE = MergeTree ORDER BY id`,
      )
      await waitForColumn(executor, database, table, 'email')

      // Hand-written destructive migration with NO `-- operation:` markers.
      await writeFile(
        join(migrationsDir, '20990101000000_drop_email.sql'),
        `ALTER TABLE ${database}.${table} DROP COLUMN email;\n`,
        'utf8',
      )

      const cliEnv = { CHKIT_JOURNAL_TABLE: journalTable, CI: '1' }
      const result = runCli(dir, ['migrate', '--config', configPath, '--execute', '--json'], cliEnv)

      // Blocked: exit 3, lists the offending migration — not applied.
      expect(result.exitCode).toBe(3)
      const payload = JSON.parse(result.stdout) as {
        destructiveMigrations: string[]
        destructiveOperations: Array<{ type: string }>
      }
      expect(payload.destructiveMigrations).toContain('20990101000000_drop_email.sql')
      expect(payload.destructiveOperations.some((op) => op.type === 'alter_table_drop_column')).toBe(true)

      // Text mode blocks with the same exit code.
      const text = runCli(dir, ['migrate', '--config', configPath, '--execute'], cliEnv)
      expect(text.exitCode).toBe(3)
      expect(text.stderr.trim().split('\n')).toEqual([
        'Blocked destructive migration execution. Re-run with --allow-destructive or set safety.allowDestructive=true after review.',
        'Destructive migrations: 20990101000000_drop_email.sql',
        'Non-interactive run detected. Pass --allow-destructive to proceed.',
      ])

      // In a real terminal, answering "no" at the prompt cancels with the same exit code.
      const cancelled = await runCliInTerminal(dir, ['migrate', '--config', configPath, '--execute'], {
        CHKIT_JOURNAL_TABLE: journalTable,
      })
      expect(cancelled.exitCode).toBe(3)
      expect(cancelled.output).toContain('Destructive migration cancelled by user.')
      expect(cancelled.output).toContain('Destructive migrations: 20990101000000_drop_email.sql')

      // The column must still exist — the destructive migration was NOT applied.
      const cols = await executor.query<{ x: number }>(
        `SELECT 1 AS x FROM system.columns WHERE database = '${database}' AND table = '${table}' AND name = 'email'`,
      )
      expect(cols.length).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(table)}`)
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      await executor.close()
    }
  }, 120_000)

  test('a DROP hand-appended to a generated migration is listed beside the planner-marked one', async () => {
    const liveEnv = getLiveEnv()
    const executor = createLiveExecutor(liveEnv)
    const database = liveEnv.clickhouseDatabase
    const journalTable = createJournalTableName('destructive_appended')
    const prefix = createPrefix('destructive_appended')
    const dir = await mkdtemp(join(tmpdir(), 'chkit-destructive-appended-e2e-'))
    const { migrationsDir, configPath } = projectPaths(dir)

    try {
      await writeProject(dir, liveEnv)
      await writeFile(
        join(migrationsDir, '20990101000000_drop_old.sql'),
        `-- operation: drop_table key=table:${database}.${prefix}old risk=danger\n` +
          `DROP TABLE IF EXISTS ${database}.${prefix}old;\n\n` +
          `DROP TABLE IF EXISTS ${database}.${prefix}legacy;\n`,
        'utf8',
      )

      const result = runCli(dir, ['migrate', '--config', configPath, '--execute', '--json'], {
        CHKIT_JOURNAL_TABLE: journalTable,
        CI: '1',
      })

      expect(result.exitCode).toBe(3)
      const payload = JSON.parse(result.stdout) as {
        destructiveMigrations: string[]
        destructiveOperations: Array<{ type: string; key: string }>
      }
      expect(payload.destructiveMigrations).toEqual(['20990101000000_drop_old.sql'])
      expect(payload.destructiveOperations.map(({ type, key }) => ({ type, key }))).toEqual([
        { type: 'drop_table', key: `table:${database}.${prefix}old` },
        { type: 'drop_table', key: `${database}.${prefix}legacy` },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await executor.command(`DROP TABLE IF EXISTS ${quoteIdent(database)}.${quoteIdent(journalTable)}`)
      await executor.close()
    }
  }, 120_000)
})

function projectPaths(dir: string): { migrationsDir: string; configPath: string } {
  return { migrationsDir: join(dir, 'chkit/migrations'), configPath: join(dir, 'clickhouse.config.ts') }
}

async function writeProject(dir: string, liveEnv: ReturnType<typeof getLiveEnv>): Promise<void> {
  const { migrationsDir, configPath } = projectPaths(dir)
  await mkdir(migrationsDir, { recursive: true })
  await writeFile(
    configPath,
    `export default {\n` +
      `  schema: '${join(dir, 'schema.ts')}',\n` +
      `  outDir: '${join(dir, 'chkit')}',\n` +
      `  migrationsDir: '${migrationsDir}',\n` +
      `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
      `  clickhouse: {\n` +
      `    url: '${liveEnv.clickhouseUrl}',\n` +
      `    username: '${liveEnv.clickhouseUser}',\n` +
      `    password: '${liveEnv.clickhousePassword}',\n` +
      `    database: '${liveEnv.clickhouseDatabase}',\n` +
      `  },\n}\n`,
    'utf8',
  )
}

const CLI_ENTRY = join(import.meta.dir, '../bin/chkit.ts')

/** Runs the CLI in a pseudo-terminal and types "no" at the first [no/yes] prompt. */
async function runCliInTerminal(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string>,
): Promise<{ exitCode: number; output: string }> {
  // HOME is cwd, with a recent dismissal of the skill-install prompt, so that prompt does not show.
  await mkdir(join(cwd, '.chkit'), { recursive: true })
  await writeFile(join(cwd, '.chkit/skill-hint.json'), JSON.stringify({ lastDismissed: new Date().toISOString() }))
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv, HOME: cwd }
  delete env.CI
  const decoder = new TextDecoder()
  let output = ''
  let answered = false
  const proc = Bun.spawn(['bun', CLI_ENTRY, ...args], {
    cwd,
    env,
    timeout: 60_000,
    killSignal: 'SIGKILL',
    terminal: {
      data(terminal, data) {
        output += decoder.decode(data, { stream: true })
        if (!answered && output.includes('[no/yes]')) {
          answered = true
          terminal.write('no\r')
        }
      },
    },
  })
  const exitCode = await proc.exited
  proc.terminal?.close()
  return { exitCode, output }
}
