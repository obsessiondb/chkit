import { resolve } from 'node:path'

import { DEFAULT_CONFIG_FILE, writeIfMissing } from '../config.js'

export async function cmdInit(): Promise<void> {
  const configPath = resolve(process.cwd(), DEFAULT_CONFIG_FILE)
  const schemaPath = resolve(process.cwd(), 'src/db/schema/example.ts')

  await writeIfMissing(
    configPath,
    `import { defineConfig } from '@chx/core'\n\nexport default defineConfig({\n  schema: './src/db/schema/**/*.ts',\n  outDir: './chx',\n  migrationsDir: './chx/migrations',\n  metaDir: './chx/meta',\n  plugins: [\n    // Typed plugin registration (recommended):\n    // import { typegen } from '@chx/plugin-typegen'\n    // typegen({ emitZod: true }),\n\n    // Legacy path-based registration (still supported):\n    // { resolve: './plugins/example-plugin.ts', options: {}, enabled: true },\n  ],\n  clickhouse: {\n    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',\n    username: process.env.CLICKHOUSE_USER ?? 'default',\n    password: process.env.CLICKHOUSE_PASSWORD ?? '',\n    database: process.env.CLICKHOUSE_DB ?? 'default',\n  },\n})\n`
  )

  await writeIfMissing(
    schemaPath,
    `import { schema, table } from '@chx/core'\n\nconst events = table({\n  database: 'default',\n  name: 'events',\n  engine: 'MergeTree',\n  columns: [\n    { name: 'id', type: 'UInt64' },\n    { name: 'source', type: 'String' },\n    { name: 'ingested_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },\n  ],\n  primaryKey: ['id'],\n  orderBy: ['id'],\n  partitionBy: 'toYYYYMM(ingested_at)',\n})\n\nexport default schema(events)\n`
  )

  console.log(`Initialized chx project files:`)
  console.log(`- ${configPath}`)
  console.log(`- ${schemaPath}`)
}
