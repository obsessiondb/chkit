import { rm, writeFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

import { join } from 'node:path'

import { spawnWithTimeout } from './spawn-cli.js'
import { createFixture, WORKSPACE_ROOT } from './testkit.test'

type Envelope = { ok: boolean; command: string; error: { code: string; message: string } }

const INGEST_PLUGIN_ENTRY = join(WORKSPACE_ROOT, 'packages/plugin-ingest/src/index.ts')

function runCli(args: string[]) {
  return spawnWithTimeout(['node', join(WORKSPACE_ROOT, 'packages/cli/dist/bin/chkit.js'), ...args], { cwd: WORKSPACE_ROOT })
}

async function createIngestFixture(): Promise<{ dir: string; configPath: string }> {
  const fixture = await createFixture()
  const entry = join(fixture.dir, 'entry.ts')
  await writeFile(entry, `import { definePipeline, defineStream, rawTable } from ${JSON.stringify(INGEST_PLUGIN_ENTRY)}
export const rows = rawTable({ database: 'default', name: 'rows' })
export const pipeline = definePipeline({ id: 'demo', streams: [defineStream({ id: 'demo.rows', destination: rows, async *read() { yield { rows: [] } } })] })
`)
  await writeFile(fixture.configPath, `import { ingest } from ${JSON.stringify(INGEST_PLUGIN_ENTRY)}
export default { entry: ${JSON.stringify(entry)}, plugins: [ingest()] }
`)
  return fixture
}

describe('@chkit/cli usage-error --json envelopes (#4)', () => {
  test('the built Node CLI reports the underlying registry connection failure', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const url = new URL('registry.json', server.url).href
    await server.stop(true)
    const result = runCli(['registry', 'list', '--registry', url, '--json'])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, command: 'registry', error: {
      message: `Registry request failed for ${url}: ECONNREFUSED. Check the network connection or pass --registry with a reachable catalog.`,
    } })
  })

  test('unknown command emits a JSON envelope on stdout (not help text)', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['definitely-not-a-command', '--config', fixture.configPath, '--json'])
      expect(result.exitCode).toBe(1)
      // A clean parse proves stdout holds ONLY the envelope — no help dump that
      // would break a `jq` consumer.
      const envelope = JSON.parse(result.stdout) as Envelope
      expect(envelope.ok).toBe(false)
      expect(envelope.command).toBe('definitely-not-a-command')
      expect(envelope.error.code).toBe('unknown_command')
      expect(envelope.error.message).toContain('Unknown command')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('unknown command without --json still prints help to stdout (human path intact)', async () => {
    const fixture = await createFixture()
    try {
      const result = runCli(['definitely-not-a-command', '--config', fixture.configPath])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Unknown command')
      // Non-JSON keeps the helpful global help on stdout.
      expect(result.stdout.length).toBeGreaterThan(0)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('well-known plugin command without the plugin emits a JSON envelope', async () => {
    const fixture = await createFixture()
    try {
      for (const command of ['codegen', 'ingest']) {
        const result = runCli([command, '--config', fixture.configPath, '--json'])
        expect(result.exitCode).toBe(1)
        const envelope = JSON.parse(result.stdout) as Envelope
        expect(envelope.ok).toBe(false)
        expect(envelope.error.code).toBe('plugin_not_configured')
        expect(envelope.error.message).toContain('plugin is not configured')
      }
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('an unknown plugin subcommand fails with an envelope instead of exit 0 and help text', async () => {
    const fixture = await createIngestFixture()
    try {
      const alias = runCli(['ingest', 'statsu', '--config', fixture.configPath, '--json'])
      expect(alias.exitCode).toBe(1)
      const envelope = JSON.parse(alias.stdout) as Envelope
      expect(envelope).toMatchObject({ ok: false, command: 'ingest', error: { code: 'unknown_subcommand' } })
      expect(envelope.error.message).toContain('Unknown ingest command "statsu". Available: run, list, doctor, repair, status.')

      const human = runCli(['ingest', 'statsu', '--config', fixture.configPath])
      expect(human.exitCode).toBe(1)
      expect(human.stderr).toContain('Unknown ingest command "statsu"')
      expect(human.stdout).toContain('chkit ingest <command> [options]')

      const forwarded = runCli(['plugin', 'ingest', 'statsu', '--config', fixture.configPath, '--json'])
      expect(forwarded.exitCode).toBe(1)
      expect(JSON.parse(forwarded.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('Unknown ingest command "statsu"') })

      const bare = runCli(['ingest', '--config', fixture.configPath])
      expect(bare.exitCode).toBe(0)
      expect(bare.stdout).toContain('chkit ingest <command> [options]')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('a plugin subcommand flag error keeps the --json contract and its help lists the flags', async () => {
    const fixture = await createIngestFixture()
    try {
      const unknown = runCli(['ingest', 'list', '--bogus', '--config', fixture.configPath, '--json'])
      expect(unknown.exitCode).toBe(1)
      expect(JSON.parse(unknown.stdout)).toMatchObject({ ok: false, command: 'ingest', error: { code: 'usage', message: 'Unknown flag: --bogus' } })
      expect(unknown.stderr).toContain('Unknown flag: --bogus')

      const missing = runCli(['ingest', 'list', '--config', fixture.configPath, '--json', '--tag'])
      expect(missing.exitCode).toBe(1)
      expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: { code: 'usage', message: 'Missing value for --tag' } })

      const help = runCli(['ingest', 'run', '--help', '--config', fixture.configPath])
      expect(help.exitCode).toBe(0)
      expect(help.stdout).toContain('chkit ingest run [options]')
      for (const flag of ['--tag <tag>', '--backfill <id>', '--from <timestamp>', '--to <timestamp>', '--max-duration <seconds>']) {
        expect(help.stdout).toContain(flag)
      }
      expect(help.stdout).not.toContain('--apply')
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
