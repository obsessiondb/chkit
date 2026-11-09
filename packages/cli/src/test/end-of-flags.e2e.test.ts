import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { spawnWithTimeout } from './spawn-cli.js'
import { createFixture, WORKSPACE_ROOT } from './testkit.test'

const CLI_ENTRY = join(WORKSPACE_ROOT, 'packages/cli/dist/bin/chkit.js')

function runCli(args: string[], cwd = WORKSPACE_ROOT) {
  // No ObsessionDB login from this machine's profile, which would add its own output.
  const home = join(tmpdir(), 'chkit-end-of-flags-home')
  return spawnWithTimeout(['node', CLI_ENTRY, ...args], { cwd, env: { HOME: home, XDG_CONFIG_HOME: home } })
}

function extraArgs(args: string): string {
  return `Got unexpected extra argument(s) (${args})`
}

describe('@chkit/cli -- ends a core command\'s flags (#614)', () => {
  test('a trailing -- is ignored; what follows it is a stray argument, even a flag', async () => {
    const fixture = await createFixture()
    try {
      const c = ['--config', fixture.configPath]
      const plain = runCli(['generate', ...c, '--dryrun', '--json'])
      expect(plain.exitCode).toBe(0)
      const trailing = runCli(['generate', ...c, '--dryrun', '--json', '--'])
      expect([trailing.exitCode, trailing.stderr, JSON.parse(trailing.stdout)]).toEqual([0, '', JSON.parse(plain.stdout)])

      const stray = runCli(['generate', ...c, '--dryrun', '--json', '--', 'foo'])
      expect([stray.exitCode, stray.stderr.trim()]).toEqual([1, extraArgs('foo')])
      expect(JSON.parse(stray.stdout)).toEqual({
        command: 'generate',
        schemaVersion: 1,
        ok: false,
        error: { code: 'usage', message: extraArgs('foo') },
      })

      for (const [args, rest] of [
        // After --, --help and --json are arguments: no help, no JSON mode.
        [['generate', ...c, '--dryrun', '--', '--help'], '--help'],
        [['generate', ...c, '--dryrun', '--', '-h'], '-h'],
        [['generate', ...c, '--dryrun', '--', '--json'], '--json'],
        [['generate', ...c, '--', '--dryrun'], '--dryrun'],
        [['generate', ...c, '--dryrun', '--', '--', 'x'], '-- x'],
        [['status', ...c, '--', 'x', 'y'], 'x y'],
        [['migrate', ...c, '--', 'x'], 'x'],
        [['drift', ...c, '--', 'x'], 'x'],
        [['check', ...c, '--', '-z'], '-z'],
        // Stray arguments before and after -- are reported together (#612).
        [['status', ...c, 'foo', '--', 'bar'], 'foo bar'],
        [['migrate', ...c, 'prod', '--', '--apply'], 'prod --apply'],
      ] as const) {
        const result = runCli([...args])
        expect([args, result.exitCode, result.stdout, result.stderr.trim()]).toEqual([args, 1, '', extraArgs(rest)])
      }

      // A --json before -- sets JSON mode for them; one after it is one of them.
      const both = runCli(['status', ...c, 'foo', '--json', '--', 'bar'])
      expect([both.exitCode, both.stderr.trim(), JSON.parse(both.stdout)]).toEqual([
        1,
        extraArgs('foo bar'),
        { command: 'status', schemaVersion: 1, ok: false, error: { code: 'usage', message: extraArgs('foo bar') } },
      ])

      // A flag never takes -- as its value, and a flag error before -- comes first.
      const missing = runCli(['generate', ...c, '--name', '--', '--dryrun'])
      expect([missing.exitCode, missing.stderr.trim()]).toEqual([1, 'Missing value for --name'])
      const unknown = runCli(['status', ...c, '--bogus', '--', 'x'])
      expect([unknown.exitCode, unknown.stderr.trim()]).toEqual([1, 'Unknown flag: --bogus'])
      // --config followed by -- has no value (#620); the --json after it is no option.
      for (const args of [
        ['generate', '--config', '--', '--json'],
        ['codegen', '--config', '--', '--json'],
        ['plugin', 'codegen', 'codegen', '--config', '--', '--json'],
      ]) {
        const result = runCli(args)
        expect([args, result.exitCode, result.stdout, result.stderr.trim()]).toEqual([
          args,
          1,
          '',
          'Missing value for --config',
        ])
      }
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('snapshot gets what follows -- as its arguments', async () => {
    const fixture = await createFixture()
    try {
      const c = ['--config', fixture.configPath]
      const trailing = runCli(['snapshot', 'rebuild', ...c, '--dryrun', '--json', '--'])
      expect(trailing.exitCode).toBe(0)
      expect(JSON.parse(trailing.stdout)).toMatchObject({ command: 'snapshot', subcommand: 'rebuild', mode: 'plan' })

      const after = runCli(['snapshot', ...c, '--', 'rebuild', '--dryrun'])
      expect([after.exitCode, after.stdout, after.stderr.split('\n')[0]]).toEqual([
        1,
        '',
        'Unexpected argument "--dryrun" for `chkit snapshot rebuild`.',
      ])
      const stray = runCli(['snapshot', 'rebuild', ...c, '--dryrun', '--', 'x'])
      expect([stray.exitCode, stray.stderr.split('\n')[0]]).toEqual([
        1,
        'Unexpected argument "x" for `chkit snapshot rebuild`.',
      ])
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('init ignores a trailing -- and rejects what follows it before writing anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-init-end-of-flags-'))
    try {
      // Resolvable @chkit/core, so init does not install dependencies.
      await mkdir(join(dir, 'node_modules/@chkit'), { recursive: true })
      await symlink(join(WORKSPACE_ROOT, 'packages/core'), join(dir, 'node_modules/@chkit/core'))
      await writeFile(join(dir, 'package.json'), '{"name":"init-end-of-flags","private":true,"type":"module"}\n')

      for (const [args, rest] of [
        [['init', '-y', '--', 'foo'], 'foo'],
        [['init', '--', '--yes'], '--yes'],
        [['init', '-y', '--', '--connect', 'bogus'], '--connect bogus'],
        // Help counts only before `--`, as in chkit-py.
        [['init', '--', '--help'], '--help'],
        [['init', '--', '-h'], '-h'],
      ] as const) {
        const result = runCli([...args], dir)
        expect([args, result.exitCode, result.stdout, result.stderr.trim()]).toEqual([args, 1, '', extraArgs(rest)])
      }
      expect(existsSync(join(dir, 'clickhouse.config.ts'))).toBe(false)

      const accepted = runCli(['init', '-y', '--'], dir)
      expect([accepted.exitCode, accepted.stderr]).toEqual([0, ''])
      expect(existsSync(join(dir, 'clickhouse.config.ts'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
