import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli as runE2eCli, startCli } from './e2e-testkit.js'
import { createFixture, runCli } from './testkit.test'

const PROFILE_ERROR = 'developer profile config was loaded'

/**
 * Stands in for a developer's own `~/.config/chkit`: points this process's
 * XDG_CONFIG_HOME at a user config dir whose profile config throws while `fn`
 * runs, so any CLI that reads it fails with {@link PROFILE_ERROR}.
 */
async function withDeveloperConfigDir<T>(fn: (configHome: string) => Promise<T> | T): Promise<T> {
  const configHome = mkdtempSync(join(tmpdir(), 'chkit-developer-xdg-'))
  mkdirSync(join(configHome, 'chkit'))
  writeFileSync(join(configHome, 'chkit', 'config.ts'), `throw new Error('${PROFILE_ERROR}')\n`)
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = configHome
  try {
    return await fn(configHome)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(configHome, { recursive: true, force: true })
  }
}

const NO_PLUGINS = 'No plugins configured. Add entries to config.plugins first.'

describe('CLI test runners keep the developer user config dir out', () => {
  test('runCli runs the CLI with an empty user config dir', async () => {
    const fixture = await createFixture()
    const result = await withDeveloperConfigDir(() =>
      runCli(['plugin', '--config', fixture.configPath, '--json'])
    )
    rmSync(fixture.dir, { recursive: true, force: true })

    expect(result.stderr).not.toContain(PROFILE_ERROR)
    // No profile plugin leaked in: the fixture's empty plugin list is reported (#613).
    expect([result.exitCode, JSON.parse(result.stdout).error]).toEqual([1, NO_PLUGINS])
  })

  test('the e2e runCli runs the CLI with an empty user config dir', async () => {
    const fixture = await createFixture()
    const result = await withDeveloperConfigDir(() =>
      runE2eCli(fixture.dir, ['plugin', '--config', fixture.configPath, '--json'])
    )
    rmSync(fixture.dir, { recursive: true, force: true })

    expect(result.stderr).not.toContain(PROFILE_ERROR)
    // No profile plugin leaked in: the fixture's empty plugin list is reported (#613).
    expect([result.exitCode, JSON.parse(result.stdout).error]).toEqual([1, NO_PLUGINS])
  })

  test('startCli runs the CLI with an empty user config dir', async () => {
    const fixture = await createFixture()
    const result = await withDeveloperConfigDir(
      () => startCli(fixture.dir, ['plugin', '--config', fixture.configPath, '--json']).result
    )
    rmSync(fixture.dir, { recursive: true, force: true })

    expect(result.stderr).not.toContain(PROFILE_ERROR)
    // No profile plugin leaked in: the fixture's empty plugin list is reported (#613).
    expect([result.exitCode, JSON.parse(result.stdout).error]).toEqual([1, NO_PLUGINS])
  })

  test('an XDG_CONFIG_HOME the test passes still reaches the CLI', async () => {
    const fixture = await createFixture()
    const result = await withDeveloperConfigDir((configHome) =>
      runCli(['plugin', '--config', fixture.configPath, '--json'], { XDG_CONFIG_HOME: configHome })
    )
    rmSync(fixture.dir, { recursive: true, force: true })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(PROFILE_ERROR)
  })
})
