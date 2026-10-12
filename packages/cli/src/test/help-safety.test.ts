import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import { spawnWithTimeout } from './spawn-cli.js'
import { WORKSPACE_ROOT } from './testkit.test.js'

const entry = join(WORKSPACE_ROOT, 'packages/cli/src/bin/chkit.ts')

test('init help never scaffolds or installs, including when --yes is supplied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-init-help-'))
  try {
    for (const flag of ['--help', '-h', '--help-plugins']) {
      const result = spawnWithTimeout(['bun', entry, 'init', flag, '--yes'], { cwd: dir })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('chkit init [options]')
      expect(await readdir(dir)).toEqual([])
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('configured-help mode stays nonmutating for configless bootstrap commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-bootstrap-help-'))
  try {
    for (const command of ['skills', 'registry', 'add']) {
      const result = spawnWithTimeout(['bun', entry, command, '--help-plugins'], { cwd: dir })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`chkit ${command}`)
      expect(await readdir(dir)).toEqual([])
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('all built-in command help bypasses configuration evaluation and initialization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-command-help-'))
  const configPath = join(dir, 'clickhouse.config.ts')
  const source = `throw new Error('CONFIG MUST NOT RUN'); export default {}`
  await writeFile(configPath, source)
  try {
    for (const args of [[], ['--help'], ['-h'], ['--config', configPath, '--help']]) {
      const result = spawnWithTimeout(['bun', entry, ...args], { cwd: dir })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Usage:')
      expect(result.stderr).not.toContain('CONFIG MUST NOT RUN')
      expect(await readdir(dir)).toEqual(['clickhouse.config.ts'])
    }
    for (const command of ['generate', 'migrate', 'status', 'drift', 'check', 'snapshot', 'query', 'plugin']) {
      const result = spawnWithTimeout(['bun', entry, '--config', configPath, command, '--help'], { cwd: dir })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`chkit ${command}`)
      expect(result.stderr).not.toContain('CONFIG MUST NOT RUN')
      expect(await readdir(dir)).toEqual(['clickhouse.config.ts'])
      expect(await readFile(configPath, 'utf8')).toBe(source)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('prefix global options dispatch a real command and preserve JSON errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-global-prefix-'))
  const configPath = join(dir, 'custom.config.ts')
  await writeFile(configPath, `throw new Error('SELECTED CONFIG'); export default {}`)
  try {
    const result = spawnWithTimeout(['bun', entry, '--json', `--config=${configPath}`, 'status'], { cwd: dir })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('SELECTED CONFIG')
    expect(result.stderr).not.toContain('Unknown command')
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, command: 'status' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('configured plugin help shows extensions without running initialization or context hooks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-plugin-help-'))
  const configPath = join(dir, 'custom.config.ts')
  await writeFile(configPath, `export default {
    schema: [],
    plugins: [{ plugin: {
      manifest: { name: 'test-extension', apiVersion: 1 },
      commands: [{ name: 'inspect', description: 'Plugin inspection', run() { throw new Error('COMMAND MUST NOT RUN') } }],
      extendCommands: [{ command: 'generate', flags: [{ name: '--test-extension', type: 'boolean', description: 'Configured extension' }] }],
      hooks: {
        onInit() { throw new Error('INITIALIZATION MUST NOT RUN') },
        onComplete() { throw new Error('COMPLETION MUST NOT RUN') },
        getContext() { throw new Error('CONTEXT MUST NOT RUN') },
      },
    } }],
  }`)
  try {
    const plain = spawnWithTimeout(['bun', entry, 'generate', '--help', '--config', configPath], { cwd: dir })
    expect(plain.exitCode).toBe(0)
    expect(plain.stdout).toContain('--help-plugins')
    expect(plain.stdout).not.toContain('--test-extension')
    const configured = spawnWithTimeout(['bun', entry, '--help-plugins', '--config', configPath, 'generate'], { cwd: dir })
    expect(configured.exitCode).toBe(0)
    expect(configured.stdout).toContain('--test-extension')
    expect(configured.stdout).toContain('Plugin: test-extension')
    expect(configured.stderr).toBe('')
    const global = spawnWithTimeout(['bun', entry, '--help-plugins', '--config', configPath], { cwd: dir })
    expect(global.exitCode).toBe(0)
    expect(global.stdout).toContain('Plugin commands:')
    expect(global.stdout).toContain('test-extension')
    expect(global.stdout).toContain('inspect')
    expect(global.stderr).toBe('')
    const unknown = spawnWithTimeout(['bun', entry, 'unknown-command', '--help-plugins', '--config', configPath], { cwd: dir })
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stderr).toContain('Unknown command: unknown-command')
    expect(unknown.stderr).not.toContain('MUST NOT RUN')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('init supports offline generation and fails closed on incomplete connection credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-init-credentials-'))
  // Resolve the installed workspace dependency without invoking a package manager.
  await symlink(join(WORKSPACE_ROOT, 'node_modules'), join(dir, 'node_modules'))
  const env = {
    HOME: dir, XDG_CONFIG_HOME: dir,
    CLICKHOUSE_URL: undefined, CLICKHOUSE_USER: undefined,
    CLICKHOUSE_PASSWORD: undefined, CLICKHOUSE_DB: 'chosen_database',
  }
  try {
    const init = spawnWithTimeout(['bun', entry, 'init', '--yes'], { cwd: dir, env })
    expect(init.exitCode).toBe(0)
    expect(init.stdout).not.toContain('installing')
    const missingDatabase = spawnWithTimeout(['bun', entry, 'generate', '--name', 'init', '--json'], {
      cwd: dir, env: { ...env, CLICKHOUSE_DB: undefined },
    })
    expect(missingDatabase.exitCode).not.toBe(0)
    expect(missingDatabase.stderr).toContain('Set CLICKHOUSE_DB to the intended database')
    expect(await readdir(dir)).not.toContain('chkit')
    const generate = spawnWithTimeout(['bun', entry, 'generate', '--dryrun', '--json'], { cwd: dir, env })
    expect(generate.exitCode).toBe(0)
    expect(generate.stdout).toContain('chosen_database')
    const status = spawnWithTimeout(['bun', entry, 'status'], { cwd: dir, env })
    expect(status.exitCode).not.toBe(0)
    expect(status.stderr).toContain('clickhouse config is required')
    const missingUser = spawnWithTimeout(['bun', entry, 'status'], {
      cwd: dir, env: { ...env, CLICKHOUSE_URL: 'http://127.0.0.1:1' },
    })
    expect(missingUser.exitCode).not.toBe(0)
    expect(missingUser.stderr).toContain('Set CLICKHOUSE_USER explicitly')
    const missingPassword = spawnWithTimeout(['bun', entry, 'status'], {
      cwd: dir, env: { ...env, CLICKHOUSE_URL: 'http://127.0.0.1:1', CLICKHOUSE_USER: 'provided_user' },
    })
    expect(missingPassword.exitCode).not.toBe(0)
    expect(missingPassword.stderr).toContain('Set CLICKHOUSE_PASSWORD explicitly')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('init preserves explicit target configuration during offline generation and snapshot rebuild', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chkit-init-target-'))
  await symlink(join(WORKSPACE_ROOT, 'node_modules'), join(dir, 'node_modules'))
  const env = {
    HOME: dir, XDG_CONFIG_HOME: dir,
    // These hosts do not exist: successful dry-run/rebuild also proves no network connection.
    CLICKHOUSE_URL: 'https://fixture.obsessiondb.com:8443',
    CLICKHOUSE_USER: 'provided_user', CLICKHOUSE_PASSWORD: 'provided_password',
    CLICKHOUSE_DB: 'chosen_database', CLICKHOUSE_CLUSTER: 'chosen_cluster',
  }
  try {
    expect(spawnWithTimeout(['bun', entry, 'init', '--yes'], { cwd: dir, env }).exitCode).toBe(0)
    const configPath = join(dir, 'clickhouse.config.ts')
    const config = await readFile(configPath, 'utf8')
    await writeFile(configPath, `import { obsessiondb } from '@chkit/plugin-obsessiondb'\n${config.replace('plugins: [', 'plugins: [obsessiondb(),')}`)
    const schemaPath = join(dir, 'src/db/schema/example.ts')
    const schema = await readFile(schemaPath, 'utf8')
    await writeFile(schemaPath, schema.replace("  engine: 'MergeTree',", "  engine: 'MergeTree',\n  settings: { storage_policy: \"'s3'\" },"))
    const generate = spawnWithTimeout(['bun', entry, 'generate', '--dryrun', '--json'], { cwd: dir, env })
    expect(generate.exitCode).toBe(0)
    expect(generate.stdout).toContain('chosen_database.events')
    expect(generate.stdout).toContain("ON CLUSTER 'chosen_cluster'")
    expect(generate.stdout).toContain("storage_policy = 's3'")
    const regularTarget = spawnWithTimeout(['bun', entry, 'generate', '--dryrun', '--json'], {
      cwd: dir, env: { ...env, CLICKHOUSE_URL: 'https://fixture.invalid' },
    })
    expect(regularTarget.exitCode).toBe(0)
    expect(regularTarget.stdout).not.toContain('storage_policy')
    const rebuild = spawnWithTimeout(['bun', entry, 'snapshot', 'rebuild', '--json'], { cwd: dir, env })
    expect(rebuild.exitCode).toBe(0)
    const snapshot = JSON.parse(await readFile(join(dir, 'chkit/meta/snapshot.json'), 'utf8'))
    expect(snapshot.definitions[0].database).toBe('chosen_database')
    expect(snapshot.definitions[0].settings.storage_policy).toBe("'s3'")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
