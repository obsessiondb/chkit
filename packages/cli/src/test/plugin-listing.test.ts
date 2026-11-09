import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CLI_ENTRY, createFixture, runCli } from './testkit.test'

// chkit-py prints the same bytes (#613): chkit_python/tests/test_plugin_listing.py.

const NO_PLUGINS_MESSAGE = 'No plugins configured. Add entries to config.plugins first.'

async function createListingFixture(withPlugins: boolean) {
  const fixture = await createFixture()
  // An empty config home, so no local ObsessionDB login registers its plugin.
  const xdgConfigHome = join(fixture.dir, 'xdg')
  await mkdir(xdgConfigHome)
  const pluginPath = join(fixture.dir, 'listing-plugins.ts')
  await writeFile(
    pluginPath,
    `import { definePlugin } from '${CLI_ENTRY}'\n\nexport const alpha = definePlugin({\n  manifest: { name: 'alpha', apiVersion: 1, version: '1.2.3' },\n  commands: [\n    { name: 'go', description: 'Go somewhere', run() {} },\n    { name: 'stay', run() {} },\n  ],\n})\n\nexport const empty = definePlugin({ manifest: { name: 'empty', apiVersion: 1 } })\n`,
    'utf8'
  )
  await writeFile(
    fixture.configPath,
    `import { alpha, empty } from '${pluginPath}'\n\nexport default {\n  schema: '${fixture.schemaPath}',\n  outDir: '${join(fixture.dir, 'chkit')}',\n  migrationsDir: '${fixture.migrationsDir}',\n  metaDir: '${fixture.metaDir}',\n  plugins: ${withPlugins ? '[{ plugin: alpha }, { plugin: empty }]' : '[]'},\n}\n`,
    'utf8'
  )
  const run = (args: string[]) =>
    runCli(['plugin', ...args, '--config', fixture.configPath], { XDG_CONFIG_HOME: xdgConfigHome })
  return { dir: fixture.dir, run }
}

describe('chkit plugin listing', () => {
  test('lists the configured plugins in config order, without the built-in ones', async () => {
    const fixture = await createListingFixture(true)
    try {
      const result = fixture.run([])
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe(
        'Configured plugins:\n- alpha (v1.2.3)\n  - go: Go somewhere\n  - stay\n- empty\n  (no commands)\n'
      )
      expect(result.exitCode).toBe(0)

      const json = fixture.run(['--json'])
      expect(json.exitCode).toBe(0)
      expect(json.stdout).toBe(
        `${JSON.stringify(
          {
            command: 'plugin',
            schemaVersion: 1,
            plugins: [
              {
                name: 'alpha',
                version: '1.2.3',
                commands: [
                  { name: 'go', description: 'Go somewhere' },
                  { name: 'stay', description: '' },
                ],
              },
              { name: 'empty', version: null, commands: [] },
            ],
          },
          null,
          2
        )}\n`
      )
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('lists one plugin\'s commands', async () => {
    const fixture = await createListingFixture(true)
    try {
      const alpha = fixture.run(['alpha'])
      expect(alpha.stdout).toBe('Plugin commands for "alpha":\n- go: Go somewhere\n- stay\n')
      expect(alpha.exitCode).toBe(0)

      const alphaJson = fixture.run(['alpha', '--json'])
      expect(alphaJson.exitCode).toBe(0)
      expect(alphaJson.stdout).toBe(
        `${JSON.stringify(
          {
            command: 'plugin',
            schemaVersion: 1,
            plugin: 'alpha',
            commands: [
              { name: 'go', description: 'Go somewhere' },
              { name: 'stay', description: '' },
            ],
          },
          null,
          2
        )}\n`
      )

      const empty = fixture.run(['empty'])
      expect(empty.stdout).toBe('Plugin "empty" has no registered commands.\n')
      expect(empty.exitCode).toBe(0)

      const emptyJson = fixture.run(['empty', '--json'])
      expect(emptyJson.exitCode).toBe(0)
      expect(JSON.parse(emptyJson.stdout)).toEqual({
        command: 'plugin',
        schemaVersion: 1,
        plugin: 'empty',
        commands: [],
      })
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('a built-in plugin is not a plugin of chkit plugin', async () => {
    const fixture = await createListingFixture(true)
    try {
      const result = fixture.run(['core'])
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('Unknown plugin "core". Available: alpha, empty.\n')
      expect(result.exitCode).toBe(1)
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })

  test('fails with exit 1 when no plugins are configured', async () => {
    const fixture = await createListingFixture(false)
    try {
      for (const args of [[], ['alpha'], ['alpha', 'go']]) {
        const result = fixture.run(args)
        expect(result.stdout).toBe('')
        expect(result.stderr).toBe(`${NO_PLUGINS_MESSAGE}\n`)
        expect(result.exitCode).toBe(1)

        const json = fixture.run([...args, '--json'])
        expect(json.exitCode).toBe(1)
        expect(json.stdout).toBe(
          `${JSON.stringify(
            { command: 'plugin', schemaVersion: 1, error: NO_PLUGINS_MESSAGE, plugins: [] },
            null,
            2
          )}\n`
        )
      }
    } finally {
      await rm(fixture.dir, { recursive: true, force: true })
    }
  })
})
