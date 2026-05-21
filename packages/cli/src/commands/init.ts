import { relative, resolve } from 'node:path'

import { DEFAULT_CONFIG_FILE, writeIfMissing } from '../runtime/config.js'

export async function cmdInit(): Promise<void> {
  const cwd = process.cwd()
  const configPath = resolve(cwd, DEFAULT_CONFIG_FILE)
  const schemaPath = resolve(cwd, 'src/db/schema/example.ts')

  const wroteConfig = await writeIfMissing(
    configPath,
    `import { defineConfig } from '@chkit/core'\n\nexport default defineConfig({\n  schema: './src/db/schema/**/*.ts',\n  outDir: './chkit',\n  migrationsDir: './chkit/migrations',\n  metaDir: './chkit/meta',\n  plugins: [\n    // Register plugins inline. Example:\n    // import { codegen } from '@chkit/plugin-codegen'\n    // codegen({ emitZod: true }),\n  ],\n  clickhouse: {\n    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',\n    username: process.env.CLICKHOUSE_USER ?? 'default',\n    password: process.env.CLICKHOUSE_PASSWORD ?? '',\n    database: process.env.CLICKHOUSE_DB ?? 'default',\n  },\n})\n`
  )

  const wroteSchema = await writeIfMissing(
    schemaPath,
    `import { schema, table } from '@chkit/core'\n\nconst events = table({\n  database: 'default',\n  name: 'events',\n  engine: 'MergeTree',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'source', type: 'String' },\n    { name: 'ingested_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },\n  ],\n  primaryKey: ['id'],\n  orderBy: ['id'],\n  partitionBy: 'toYYYYMM(ingested_at)',\n})\n\nexport default schema(events)\n`
  )

  if (wroteConfig) console.log(`Created ${relative(cwd, configPath)}`)
  if (wroteSchema) console.log(`Created ${relative(cwd, schemaPath)}`)

  if (wroteConfig || wroteSchema) {
    console.log('')
    console.log('Next steps:')
    console.log('  1. Set CLICKHOUSE_URL (and CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DB if needed).')
    console.log('  2. Edit src/db/schema/example.ts to match your data.')
    console.log('  3. Run: bunx chkit generate --name init')
    console.log('  4. Run: bunx chkit migrate --apply')
    console.log('')
    console.log('Docs: https://chkit.obsessiondb.com/getting-started/')
  }
}
