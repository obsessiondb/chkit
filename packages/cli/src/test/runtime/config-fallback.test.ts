import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../../runtime/config.js'

interface Sandbox {
  root: string
  cwd: string
  userConfigDir: string
  cleanup: () => void
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'chkit-fallback-'))
  const cwd = join(root, 'project')
  const userConfigDir = join(root, 'xdg', 'chkit')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(userConfigDir, { recursive: true })
  return {
    root,
    cwd,
    userConfigDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const PROJECT_CONFIG = `export default { schema: ['./schema/*.ts'], outDir: './chkit' }`
const PROFILE_CONFIG = `export default { schema: [], plugins: [] }`

describe('loadConfig fallback', () => {
  test('loads project config when clickhouse.config.ts exists in cwd', async () => {
    const sandbox = createSandbox()
    writeFileSync(join(sandbox.cwd, 'clickhouse.config.ts'), PROJECT_CONFIG)

    const result = await loadConfig(
      undefined,
      {},
      { cwd: sandbox.cwd, userConfigDir: sandbox.userConfigDir },
    )

    expect(result.source).toBe('project')
    expect(result.path).toBe(join(sandbox.cwd, 'clickhouse.config.ts'))
    expect(result.config.schema).toEqual(['./schema/*.ts'])
    sandbox.cleanup()
  })

  test('falls back to user profile config.ts when no project config exists', async () => {
    const sandbox = createSandbox()
    writeFileSync(join(sandbox.userConfigDir, 'config.ts'), PROFILE_CONFIG)

    const result = await loadConfig(
      undefined,
      {},
      { cwd: sandbox.cwd, userConfigDir: sandbox.userConfigDir },
    )

    expect(result.source).toBe('profile')
    expect(result.path).toBe(join(sandbox.userConfigDir, 'config.ts'))
    sandbox.cleanup()
  })

  test('synthesizes a config with obsessiondb plugin when only credentials.json exists', async () => {
    const sandbox = createSandbox()
    writeFileSync(
      join(sandbox.userConfigDir, 'credentials.json'),
      JSON.stringify({ access_token: 'abc', base_url: 'https://x' }),
    )

    const result = await loadConfig(
      undefined,
      {},
      { cwd: sandbox.cwd, userConfigDir: sandbox.userConfigDir },
    )

    expect(result.source).toBe('synthesized')
    expect(result.path).toBe(join(sandbox.userConfigDir, 'clickhouse.config.ts'))
    expect(result.config.plugins).toHaveLength(1)
    expect(result.config.schema).toEqual([])
    sandbox.cleanup()
  })

  test('throws when neither config nor credentials exist', async () => {
    const sandbox = createSandbox()

    await expect(
      loadConfig(undefined, {}, { cwd: sandbox.cwd, userConfigDir: sandbox.userConfigDir }),
    ).rejects.toThrow(/Config not found/)
    sandbox.cleanup()
  })

  test('uses a query-specific error when no project config or profile exists', async () => {
    const sandbox = createSandbox()

    await expect(
      loadConfig(undefined, {}, {
        command: 'query',
        cwd: sandbox.cwd,
        userConfigDir: sandbox.userConfigDir,
      }),
    ).rejects.toThrow(/Run 'chkit obsessiondb login' to query ObsessionDB/)
    sandbox.cleanup()
  })

  test('can synthesize a config without credentials for ObsessionDB bootstrap commands', async () => {
    const sandbox = createSandbox()

    const result = await loadConfig(
      undefined,
      {},
      {
        cwd: sandbox.cwd,
        userConfigDir: sandbox.userConfigDir,
        allowSynthesizedProfileConfig: true,
      },
    )

    expect(result.source).toBe('synthesized')
    expect(result.path).toBe(join(sandbox.userConfigDir, 'clickhouse.config.ts'))
    expect(result.config.plugins).toHaveLength(1)
    expect(result.config.schema).toEqual([])
    sandbox.cleanup()
  })

  test('explicit --config path overrides fallback resolution', async () => {
    const sandbox = createSandbox()
    const explicit = join(sandbox.root, 'custom.config.ts')
    writeFileSync(explicit, PROJECT_CONFIG)
    writeFileSync(
      join(sandbox.userConfigDir, 'credentials.json'),
      JSON.stringify({ access_token: 'abc', base_url: 'https://x' }),
    )

    const result = await loadConfig(
      explicit,
      {},
      { cwd: sandbox.cwd, userConfigDir: sandbox.userConfigDir },
    )

    expect(result.source).toBe('project')
    expect(result.path).toBe(explicit)
    sandbox.cleanup()
  })
})
