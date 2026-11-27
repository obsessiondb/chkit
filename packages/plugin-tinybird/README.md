# @chkit/plugin-tinybird

Plugin to import a Tinybird (Forward) project as a chkit schema: datasources become tables, materialized pipes become materialized views, copy pipes become refreshable materialized views, and endpoints become typed queries.

Part of the [chkit](https://github.com/obsessiondb/chkit) monorepo. This plugin extends the [`chkit`](https://www.npmjs.com/package/chkit) CLI with `chkit plugin tinybird import`.

## Install

```bash
bun add -d @chkit/plugin-tinybird
```

## Usage

Register the plugin in your config:

```ts
// clickhouse.config.ts
import { defineConfig } from '@chkit/core'
import { tinybird } from '@chkit/plugin-tinybird'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [
    tinybird({ project: './tinybird', database: 'analytics' }),
  ],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  },
})
```

Then run:

```bash
bunx chkit plugin tinybird import --report ./tinybird-import.json
```

Every object that does not translate is listed with the reason, in the command output, the report and the head of the generated schema file.

## Documentation

See the [chkit documentation](https://chkit.obsessiondb.com/plugins/tinybird/).

## License

[MIT](../../LICENSE)
