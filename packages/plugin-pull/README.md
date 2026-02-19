# @chkit/plugin-pull

Plugin to pull existing ClickHouse table schemas into local chkit schema files.

Part of the [chkit](https://github.com/obsessiondb/chkit) monorepo.

## Install

```bash
bun add -d @chkit/plugin-pull
```

## Usage

Register the plugin in your config:

```ts
// clickhouse.config.ts
import { defineConfig } from '@chkit/core'
import { pull } from '@chkit/plugin-pull'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [
    pull({ outFile: './src/db/schema/pulled.ts' }),
  ],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  },
})
```

Then run:

```bash
bunx chkit pull
```

## Documentation

See the [chkit documentation](https://chkit.obsessiondb.com).

## License

[MIT](../../LICENSE)
