# @chkit/core

TypeScript schema DSL, configuration, and diff engine for ClickHouse schema management.

Part of the [chkit](https://github.com/obsessiondb/chkit) monorepo. This package is typically used together with the [`chkit`](https://www.npmjs.com/package/chkit) CLI.

## Install

```sh
bun add -d chkit @chkit/core
```

## Usage

Define your ClickHouse schema in TypeScript:

```ts
// src/db/schema/events.ts
import { schema, table } from '@chkit/core'

const events = table({
  database: 'default',
  name: 'events',
  engine: 'MergeTree',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'source', type: 'String' },
    { name: 'occurred_at', type: 'DateTime64(3)', default: { expression: 'now64(3)' } },
  ],
  primaryKey: ['id'],
  orderBy: ['id'],
  partitionBy: 'toYYYYMM(occurred_at)',
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
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: 'default',
  },
})
```

Set the connection environment variables for a development database, then generate, review, and apply a migration:

```sh
bunx chkit generate --name create-events
# Review the SQL in chkit/migrations/ and preview the plan:
bunx chkit migrate --json
bunx chkit migrate --apply
bunx chkit check
```

Commit schema definitions, migration files, and `chkit/meta/` together. Change a definition and repeat the workflow to evolve the database.

## Documentation

- [First-schema tutorial](https://chkit.obsessiondb.com/tutorials/first-schema/) — a complete migration workflow.
- [Schema DSL reference](https://chkit.obsessiondb.com/schema/dsl-reference/) — tables, views, materialized views, dictionaries, and schema options.
- [Configuration](https://chkit.obsessiondb.com/configuration/overview/) — config files, connections, and plugins.
- [Python overview (alpha)](https://chkit.obsessiondb.com/python/overview/) — the equivalent schema workflow with `chkit-py`.

## License

[MIT](../../LICENSE)
