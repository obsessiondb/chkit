import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from './e2e-testkit.js'
import { CLI_ENTRY, CORE_ENTRY } from './testkit.test'

const SCHEMA = `import { materializedView, schema, table } from '${CORE_ENTRY}'

const rollup = table({
  database: 'app',
  name: 'daily_rollup',
  columns: [{ name: 'day', type: 'Date' }],
  engine: 'MergeTree()',
  primaryKey: ['day'],
  orderBy: ['day'],
})

const rollupMv = materializedView({
  database: 'app',
  name: 'daily_mv',
  to: { database: 'app', name: 'daily_rollup' },
  refresh: { every: '1 HOUR' },
  as: 'SELECT today() AS day',
})

export default schema(rollup, rollupMv)
`

describe('@chkit/cli refreshable view with a Replicated target', () => {
  test('generate warns, without failing, when a plugin hook makes the target Replicated in place', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-rmv-replicated-'))
    try {
      await writeFile(join(dir, 'schema.ts'), SCHEMA, 'utf8')
      // The hook edits the target engine in place, with non-canonical padding, and returns nothing.
      await writeFile(join(dir, 'plugin.ts'), `import { definePlugin } from '${CLI_ENTRY}'

export const plugin = definePlugin({
  manifest: { name: 'engine-probe', apiVersion: 1 },
  hooks: {
    onSchemaLoaded(context) {
      for (const definition of context.definitions) {
        if (definition.kind === 'table') definition.engine = '  ReplicatedMergeTree  '
      }
    },
  },
})
`, 'utf8')
      await writeFile(join(dir, 'clickhouse.config.ts'), `import { plugin } from './plugin.ts'

export default {
  schema: './schema.ts',
  outDir: './chkit',
  plugins: [{ plugin }],
}
`, 'utf8')

      const generate = runCli(dir, ['generate', '--name', 'init', '--json'])

      expect(generate.exitCode, generate.stderr).toBe(0)
      const payload = JSON.parse(generate.stdout) as { migrationFile: string | null; warnings: string[] }
      expect(payload.migrationFile).toBeTruthy()
      expect(payload.warnings).toEqual([
        'Materialized view app.daily_mv refreshes a replicated target app.daily_rollup (ReplicatedMergeTree()) without APPEND. ClickHouse refuses this in a non-replicated database such as Atomic; ObsessionDB, ClickHouse Cloud and Replicated databases accept it. On a non-replicated database, set refresh.append = true or target a non-replicated table.',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
