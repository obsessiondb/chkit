import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { getRequiredEnv, runCli } from './e2e-testkit.js'

describe('@chkit/cli query error surface e2e', () => {
  test('a SQL syntax error is clean: no "Plugin core failed" wrapper (#20), no injected FORMAT (#24)', async () => {
    const { clickhouseUrl, clickhouseUser, clickhousePassword, clickhouseDatabase } =
      getRequiredEnv()
    const dir = await mkdtemp(join(tmpdir(), 'chkit-query-e2e-'))
    const configPath = join(dir, 'clickhouse.config.ts')
    await writeFile(
      configPath,
      `export default {\n` +
        `  schema: '${join(dir, 'schema.ts')}',\n` +
        `  outDir: '${join(dir, 'chkit')}',\n` +
        `  migrationsDir: '${join(dir, 'chkit/migrations')}',\n` +
        `  metaDir: '${join(dir, 'chkit/meta')}',\n` +
        `  clickhouse: {\n` +
        `    url: '${clickhouseUrl}',\n` +
        `    username: '${clickhouseUser}',\n` +
        `    password: '${clickhousePassword}',\n` +
        `    database: '${clickhouseDatabase}',\n` +
        `  },\n}\n`,
      'utf8',
    )

    try {
      const result = runCli(dir, ['query', 'SELECT count( FROM system.one', '--config', configPath], {
        HOME: dir,
        XDG_CONFIG_HOME: dir,
      })
      expect(result.exitCode).toBe(1)
      const combined = `${result.stdout}\n${result.stderr}`
      // The underlying ClickHouse syntax error still surfaces...
      expect(combined.toLowerCase()).toContain('syntax error')
      // ...but core is a built-in plugin, so its command error is not wrapped.
      expect(combined).not.toContain('Plugin "core" failed')
      // ...and the FORMAT clause chkit injects is stripped (the user never typed it).
      expect(combined).not.toContain('FORMAT JSON')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
