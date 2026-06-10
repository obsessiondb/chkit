import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { getRequiredEnv, runCli } from './e2e-testkit.js'

describe('@chkit/cli auth error e2e', () => {
  test('a wrong password yields one clean line, not the raw ClickHouse server blurb (#7)', async () => {
    const { clickhouseUrl, clickhouseUser, clickhouseDatabase } = getRequiredEnv()
    const dir = await mkdtemp(join(tmpdir(), 'chkit-auth-e2e-'))
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
        `    password: 'definitely-wrong-password-xyz',\n` +
        `    database: '${clickhouseDatabase}',\n` +
        `  },\n}\n`,
      'utf8',
    )

    try {
      // HOME/XDG override isolates the run from any stored ObsessionDB profile,
      // so the vanilla executor path (and wrapConnectionError) is exercised.
      const result = runCli(dir, ['status', '--config', configPath, '--json'], {
        HOME: dir,
        XDG_CONFIG_HOME: dir,
      })
      expect(result.exitCode).toBe(1)
      const combined = `${result.stdout}\n${result.stderr}`
      expect(combined).toContain(`Authentication failed for user "${clickhouseUser}"`)
      expect(combined).toContain('Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD')
      // The leaked server remediation blurb must be gone.
      expect(combined).not.toContain('clickhouse.cloud')
      expect(combined).not.toContain('/etc/clickhouse-server')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
