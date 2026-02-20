# @chkit/core

Schema DSL, configuration, and diff engine for chkit.

Part of the [chkit](https://github.com/obsessiondb/chkit) monorepo. This package is typically used together with the [`chkit`](https://www.npmjs.com/package/chkit) CLI.

## Install

```bash
bun add @chkit/core
```

## Usage

Define your ClickHouse schema in TypeScript:

```ts
import { defineConfig, schema, table, view, materializedView } from '@chkit/core'

const events = table({
  database: 'default',
  name: 'events',
  engine: 'MergeTree',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'source', type: 'String' },
    { name: 'ingested_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
  ],
  primaryKey: ['id'],
  orderBy: ['id'],
})

export default schema(events)
```

Configure your project:

```ts
// clickhouse.config.ts
import { defineConfig } from '@chkit/core'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  },
})
```

## Documentation

See the [chkit documentation](https://chkit.obsessiondb.com).

## License

[MIT](../../LICENSE)
