import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../../runtime/config.js'

const CLI_ENTRY = join(import.meta.dir, '../../bin/chkit.ts')

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

function runCli(sandbox: Sandbox, args: string[]) {
  const result = Bun.spawnSync({
    cmd: ['bun', CLI_ENTRY, ...args],
    cwd: sandbox.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(sandbox.root, 'xdg'),
    },
  })
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

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
    expect(result.path).toBe('<default:obsessiondb>')
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
    expect(result.path).toBe('<default:obsessiondb>')
    expect(result.config.plugins).toHaveLength(1)
    expect(result.config.schema).toEqual([])
    sandbox.cleanup()
  })

  test('recognizes ObsessionDB bootstrap commands after global plugin flags', () => {
    const sandbox = createSandbox()

    const result = runCli(sandbox, ['plugin', '--json', 'obsessiondb'])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'plugin',
      plugin: 'obsessiondb',
    })
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

describe('loadConfig profile layering', () => {
  test('layers profile config under project (project keys win, profile keys fill gaps)', async () => {
    const sandbox = createSandbox()
    writeFileSync(
      join(sandbox.userConfigDir, 'config.ts'),
      `export default {
        schema: [],
        outDir: './from-profile',
        clickhouse: { url: 'https://profile/clickhouse', username: 'pu', database: 'pdb' },
      }`,
    )
    writeFileSync(
      join(sandbox.cwd, 'clickhouse.config.ts'),
      `export default {
        schema: ['./schema/*.ts'],
        clickhouse: { url: 'https://project/clickhouse' },
      }`,
    )

    const result = await loadConfig(
      undefined,
      {},
      { cwd: sandbox.cwd, userConfigDir: sandbox.userConfigDir },
    )

    expect(result.source).toBe('project')
    expect(result.profileLayered).toBe(true)
    expect(result.config.outDir).toBe('./from-profile')
    expect(result.config.schema).toEqual(['./schema/*.ts'])
    expect(result.config.clickhouse?.url).toBe('https://project/clickhouse')
    expect(result.config.clickhouse?.username).toBe('pu')
    expect(result.config.clickhouse?.database).toBe('pdb')
    sandbox.cleanup()
  })

  test('layers synthesized obsessiondb plugin under a project that has no plugins', async () => {
    const sandbox = createSandbox()
    writeFileSync(
      join(sandbox.cwd, 'clickhouse.config.ts'),
      `export default { schema: ['./schema/*.ts'] }`,
    )
    writeFileSync(
      join(sandbox.userConfigDir, 'credentials.json'),
      JSON.stringify({ access_token: 'abc', base_url: 'https://x' }),
    )

    const result = await loadConfig(
      undefined,
      {},
      { cwd: sandbox.cwd, userConfigDir: sandbox.userConfigDir },
    )

    expect(result.source).toBe('project')
    expect(result.profileLayered).toBe(true)
    expect(result.path).toBe(join(sandbox.cwd, 'clickhouse.config.ts'))
    expect(result.config.plugins).toHaveLength(1)
    sandbox.cleanup()
  })

  test('project plugin with same name replaces profile plugin (no duplicates)', async () => {
    const sandbox = createSandbox()
    writeFileSync(
      join(sandbox.userConfigDir, 'config.ts'),
      `export default {
        schema: [],
        plugins: [{ plugin: { manifest: { name: 'obsessiondb', apiVersion: 1 } }, name: 'obsessiondb', options: { source: 'profile' } }],
      }`,
    )
    writeFileSync(
      join(sandbox.cwd, 'clickhouse.config.ts'),
      `export default {
        schema: ['./schema/*.ts'],
        plugins: [{ plugin: { manifest: { name: 'obsessiondb', apiVersion: 1 } }, name: 'obsessiondb', options: { source: 'project' } }],
      }`,
    )

    const result = await loadConfig(
      undefined,
      {},
      { cwd: sandbox.cwd, userConfigDir: sandbox.userConfigDir },
    )

    expect(result.config.plugins).toHaveLength(1)
    const reg = result.config.plugins[0] as { options?: { source?: string } }
    expect(reg.options?.source).toBe('project')
    sandbox.cleanup()
  })

  test('project plugins with distinct names are concatenated under profile plugins', async () => {
    const sandbox = createSandbox()
    writeFileSync(
      join(sandbox.userConfigDir, 'credentials.json'),
      JSON.stringify({ access_token: 'abc', base_url: 'https://x' }),
    )
    writeFileSync(
      join(sandbox.cwd, 'clickhouse.config.ts'),
      `export default {
        schema: ['./schema/*.ts'],
        plugins: [{ plugin: { manifest: { name: 'codegen', apiVersion: 1 } }, name: 'codegen' }],
      }`,
    )

    const result = await loadConfig(
      undefined,
      {},
      { cwd: sandbox.cwd, userConfigDir: sandbox.userConfigDir },
    )

    expect(result.config.plugins).toHaveLength(2)
    const names = result.config.plugins.map((p) => (p as { name?: string }).name)
    expect(names).toEqual(['obsessiondb', 'codegen'])
    sandbox.cleanup()
  })

  test('project config alone (no profile, no credentials) does not layer', async () => {
    const sandbox = createSandbox()
    writeFileSync(join(sandbox.cwd, 'clickhouse.config.ts'), PROJECT_CONFIG)

    const result = await loadConfig(
      undefined,
      {},
      { cwd: sandbox.cwd, userConfigDir: sandbox.userConfigDir },
    )

    expect(result.source).toBe('project')
    expect(result.profileLayered).toBe(false)
    expect(result.config.plugins).toHaveLength(0)
    sandbox.cleanup()
  })

  test('explicit --config also gets the profile layered underneath', async () => {
    const sandbox = createSandbox()
    const explicit = join(sandbox.root, 'custom.config.ts')
    writeFileSync(explicit, `export default { schema: ['./schema/*.ts'] }`)
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
    expect(result.profileLayered).toBe(true)
    expect(result.config.plugins).toHaveLength(1)
    sandbox.cleanup()
  })
})
