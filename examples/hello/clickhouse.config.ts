import { defineConfig } from '@chkit/core'
import { obsessiondb } from '@chkit/plugin-obsessiondb'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  migrationsDir: './chkit/migrations',
  metaDir: './chkit/meta',
  plugins: [obsessiondb()],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: 'default',
  },
})
