# @chkit/plugin-backfill

Plugin for data backfill operations in chkit.

Part of the [chkit](https://github.com/obsessiondb/chkit) monorepo. This plugin extends the [`chkit`](https://www.npmjs.com/package/chkit) CLI with data backfill commands.

## Install

```bash
bun add -d @chkit/plugin-backfill
```

## Usage

Register the plugin in your config:

```ts
// clickhouse.config.ts
import { defineConfig } from '@chkit/core'
import { backfill } from '@chkit/plugin-backfill'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [
    backfill(),
  ],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  },
})
```

## Documentation

See the [chkit documentation](https://chkit.obsessiondb.com).

## License

[MIT](../../LICENSE)
