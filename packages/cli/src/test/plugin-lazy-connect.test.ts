import { afterEach, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { startCli } from './e2e-testkit.js'
import { CLI_ENTRY, createFixture } from './testkit.test'

// `chkit plugin <name> <command>` connects to the `clickhouse` block only when
// the command sends SQL through its default executor: a command that a
// plugin's getContext gives its own executor, or one that sends no SQL, never
// connects there. chkit-py does the same (tests/test_plugin_lazy_connect.py).
// A local listener counts the connections made to the configured URL.

const PROBE_PLUGIN = `import { definePlugin } from '${CLI_ENTRY}'

export const plugin = definePlugin({
  manifest: { name: 'probe', apiVersion: 1 },
  hooks: {
    getContext({ command }) {
      if (command !== 'own') return undefined
      return { executor: { own: true, async close() {} } }
    },
  },
  commands: [
    { name: 'own', run(ctx) { console.log(JSON.stringify(ctx.pluginContext.executor.own === true)) } },
    { name: 'nosql', run(ctx) { console.log(JSON.stringify(ctx.pluginContext.hasExecutor)) } },
  ],
})
`

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function startListener(): { port: number; connections: () => number } {
  let count = 0
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        count += 1
        socket.end()
      },
      data() {},
    },
  })
  cleanups.push(() => server.stop(true))
  return { port: server.port, connections: () => count }
}

async function createProbeFixture(port: number) {
  const fixture = await createFixture()
  cleanups.push(() => rm(fixture.dir, { recursive: true, force: true }))
  const probePath = join(fixture.dir, 'probe-plugin.ts')
  await writeFile(probePath, PROBE_PLUGIN, 'utf8')
  await writeFile(
    fixture.configPath,
    `import { plugin } from '${probePath}'

export default {
  schema: '${fixture.schemaPath}',
  outDir: '${join(fixture.dir, 'chkit')}',
  migrationsDir: '${fixture.migrationsDir}',
  metaDir: '${fixture.metaDir}',
  clickhouse: { url: 'http://127.0.0.1:${port}', username: 'default', password: '', database: 'default' },
  plugins: [{ plugin }],
}
`,
    'utf8'
  )
  return fixture
}

describe('plugin command default executor', () => {
  for (const command of ['own', 'nosql']) {
    test(`${command}: never connects to the clickhouse block`, async () => {
      const listener = startListener()
      const fixture = await createProbeFixture(listener.port)

      const result = await startCli(fixture.dir, ['plugin', 'probe', command, '--config', fixture.configPath], {}, { timeoutMs: 30_000 }).result

      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('true')
      expect(listener.connections()).toBe(0)
    })
  }
})
