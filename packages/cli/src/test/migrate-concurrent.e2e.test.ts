import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ClickHouseExecutor } from '@chkit/clickhouse'

import {
  type CliResult,
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  quoteIdent,
  startCli,
  waitForTable,
} from './e2e-testkit.js'

// #716: two `migrate --apply` runs at once against one target both applied
// the same pending migration. The migrate lock lets one of them apply it.

const TIMEOUT_MS = 180_000
const ROWS = 16

interface Fixture {
  dir: string
  config: string
  database: string
  journalTable: string
  migration: string
  executor: ClickHouseExecutor
}

describe('concurrent migrate runs (#716)', () => {
  for (const mode of ['sync', 'async'] as const) {
    test(`two runs at once apply a pending ${mode} load once`, async () => {
      const fixture = await createFixture(`concurrent_${mode}`, mode)
      try {
        const runs = await Promise.all([migrate(fixture).result, migrate(fixture).result])
        for (const run of runs) {
          if (run.exitCode !== 0) expect(lockErrorCode(run), formatTestDiagnostic('concurrent run', run)).toBe('migrate_locked')
        }
        expect(runs.some((run) => run.exitCode === 0), runs.map((run) => formatTestDiagnostic('run', run)).join('\n')).toBe(true)
        expect(await countEvents(fixture)).toBe(ROWS)
      } finally {
        await dropFixture(fixture)
      }
    }, TIMEOUT_MS)
  }
})

async function createFixture(label: string, mode: 'sync' | 'async'): Promise<Fixture> {
  const env = getLiveEnv()
  const prefix = createPrefix(label)
  const dir = await mkdtemp(join(tmpdir(), `chkit-${label}-e2e-`))
  const migrationsDir = join(dir, 'chkit/migrations')
  await mkdir(migrationsDir, { recursive: true })
  const database = `${prefix}db`
  const migration = `20990101000000_${prefix}load.sql`
  // About 4 s at 0.25 s per row, so both runs read the journal before either
  // records the migration applied.
  await writeFile(
    join(migrationsDir, migration),
    [
      `-- operation: load_table_data key=table:events risk=caution${mode === 'async' ? ' mode=async' : ''}`,
      `INSERT INTO events SELECT rand64() FROM numbers(${ROWS}) WHERE sleepEachRow(0.25) = 0 SETTINGS max_block_size = 1;`,
      '',
    ].join('\n'),
    'utf8',
  )
  const config = join(dir, 'clickhouse.config.ts')
  await writeFile(
    config,
    `export default {\n` +
      `  schema: '${join(dir, 'schema.ts')}',\n` +
      `  outDir: '${join(dir, 'chkit')}',\n` +
      `  migrationsDir: '${migrationsDir}',\n` +
      `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
      `  clickhouse: {\n` +
      `    url: '${env.clickhouseUrl}',\n` +
      `    username: '${env.clickhouseUser}',\n` +
      // The password reaches the CLI through its environment, not the file.
      `    password: process.env.CHKIT_E2E_PASSWORD,\n` +
      `    database: '${database}',\n` +
      `  },\n}\n`,
    'utf8',
  )
  const fixture: Fixture = {
    dir,
    config,
    database,
    journalTable: createJournalTableName(label),
    migration,
    executor: createLiveExecutor(env),
  }
  await fixture.executor.command(`CREATE DATABASE ${quoteIdent(database)}`)
  await fixture.executor.command(`CREATE TABLE ${quoteIdent(database)}.events (id UInt64) ENGINE = MergeTree ORDER BY id`)
  await waitForTable(fixture.executor, database, 'events')
  return fixture
}

async function dropFixture(fixture: Fixture): Promise<void> {
  await fixture.executor.command(`DROP DATABASE IF EXISTS ${quoteIdent(fixture.database)} SYNC`)
  await fixture.executor.close()
  await rm(fixture.dir, { recursive: true, force: true })
}

function migrate(fixture: Fixture, extraArgs: string[] = []): { result: Promise<CliResult>; kill: () => void } {
  return startCli(fixture.dir, ['migrate', '--config', fixture.config, '--execute', '--json', ...extraArgs], {
    CHKIT_JOURNAL_TABLE: fixture.journalTable,
    CHKIT_E2E_PASSWORD: getLiveEnv().clickhousePassword,
    CI: '1',
  })
}

/** The `--json` error code of a failed run. */
function lockErrorCode(run: CliResult): string | undefined {
  const payload = JSON.parse(run.stdout) as { error?: { code?: string } }
  return payload.error?.code
}

async function countEvents(fixture: Fixture): Promise<number> {
  const db = quoteIdent(fixture.database)
  const [row] = await fixture.executor.query<{ n: string }>(`SELECT toString(count()) AS n FROM ${db}.events`)
  return Number(row?.n)
}
