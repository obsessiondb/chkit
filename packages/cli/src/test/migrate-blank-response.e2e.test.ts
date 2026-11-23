import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  createJournalTableName,
  createLiveExecutor,
  createPrefix,
  formatTestDiagnostic,
  getLiveEnv,
  quoteIdent,
  startCli,
} from './e2e-testkit.js'

describe('missing journal HTTP response (OBS-16)', () => {
  test('stops status and migrate without replaying an applied INSERT', async () => {
    const env = getLiveEnv()
    const db = createLiveExecutor(env)
    const sink = `${createPrefix('blank')}sink`
    const qualified = `${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(sink)}`
    const journal = createJournalTableName('blank')
    const dir = await mkdtemp(join(tmpdir(), 'chkit-blank-'))
    const migrations = join(dir, 'migrations')
    const config = join(dir, 'clickhouse.config.ts')
    let dropJournal = false
    let dropped = 0
    const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const sql = await request.text()
      if (dropJournal && sql.includes(journal) && sql.includes('migration_completed = true')) {
        dropped++
        return new Response('')
      }
      const target = new URL(env.clickhouseUrl)
      target.search = new URL(request.url).search
      const headers = new Headers(request.headers)
      headers.delete('host')
      headers.delete('content-length')
      const upstream = await fetch(target, { method: 'POST', headers, body: sql })
      const responseHeaders = new Headers(upstream.headers)
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
    } })
    const cli = (command: string, extra: string[] = []) => startCli(dir,
      [command, '--config', config, '--json', ...extra],
      { CHKIT_JOURNAL_TABLE: journal, CI: '1' },
    ).result
    try {
      await mkdir(migrations)
      await writeFile(config, `export default ${JSON.stringify({
        schema: join(dir, 'schema.ts'), outDir: dir, migrationsDir: migrations,
        metaDir: join(dir, 'meta'),
        clickhouse: { url: proxy.url.toString(), username: env.clickhouseUser,
          password: env.clickhousePassword, database: env.clickhouseDatabase },
      })}`)
      await writeFile(join(migrations, '20990101000000_insert.sql'),
        `-- operation: load_table_data key=table:${sink} risk=caution\nINSERT INTO ${qualified} SELECT 1;\n`)
      await db.command(`CREATE TABLE ${qualified} (id UInt8) ENGINE = MergeTree ORDER BY id`)
      const first = await cli('migrate', ['--apply'])
      expect(first.exitCode, formatTestDiagnostic('first migrate', first)).toBe(0)
      expect(await db.query(`SELECT count() AS n FROM ${qualified}`)).toEqual([{ n: 1 }])
      dropJournal = true
      for (const command of ['status', 'migrate']) {
        const result = await cli(command, command === 'migrate' ? ['--apply'] : [])
        expect(result.exitCode, formatTestDiagnostic(command, result)).toBe(1)
        expect(JSON.parse(result.stdout).ok).toBe(false)
      }
      expect(dropped).toBeGreaterThanOrEqual(2)
      expect(await db.query(`SELECT count() AS n FROM ${qualified}`)).toEqual([{ n: 1 }])
      dropJournal = false
      const resumed = await cli('migrate', ['--apply'])
      expect(resumed.exitCode, formatTestDiagnostic('healthy rerun', resumed)).toBe(0)
      expect(await db.query(`SELECT count() AS n FROM ${qualified}`)).toEqual([{ n: 1 }])
    } finally {
      proxy.stop(true)
      await db.command(`DROP TABLE IF EXISTS ${qualified} SYNC`)
      await db.command(`DROP TABLE IF EXISTS ${quoteIdent(env.clickhouseDatabase)}.${quoteIdent(journal)} SYNC`)
      await db.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
