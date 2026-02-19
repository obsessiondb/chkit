---
title: Pull Plugin
description: Introspect live ClickHouse tables, views, and materialized views and generate chkit schema files.
---

This document covers practical usage of the optional `pull` plugin.

## What it does

- Connects to a live ClickHouse instance and introspects table metadata (columns, engines, indexes, projections, partitioning, TTL, settings).
- Introspects views and materialized views (including `TO` clause parsing).
- Generates a deterministic TypeScript schema file using `@chkit/core` builders.
- Supports filtering by database and dry-run previews.

## How it fits your workflow

The plugin is designed for bootstrapping a chkit project from an existing ClickHouse deployment.

- [`chkit pull`](/cli/pull/) (alias for `chkit plugin pull schema`):
  - Connects to ClickHouse, introspects all schema objects, and writes a TypeScript schema file.
  - Generated file works directly with [`chkit generate`](/cli/generate/) and [`chkit check`](/cli/check/).
- Dry-run mode previews the output without writing to disk.

## Plugin setup

In `clickhouse.config.ts`, register `pull(...)` from `@chkit/plugin-pull`.

```ts
import { defineConfig } from '@chkit/core'
import { pull } from '@chkit/plugin-pull'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  plugins: [
    pull({
      outFile: './src/db/schema/pulled.ts',
      databases: ['analytics'],
      overwrite: false,
    }),
  ],
})
```

## Options

- `outFile` (default: `./src/db/schema/pulled.ts`) — Output file path for the generated schema.
- `databases` (default: `[]`, meaning all) — Filter to specific databases.
- `overwrite` (default: `false`) — Allow overwriting an existing output file.
- `introspect` (default: built-in) — Custom introspection function (advanced).

Invalid option values fail fast at startup via plugin config validation.

## Commands

- `chkit plugin pull schema` (also available as [`chkit pull`](/cli/pull/))
  - Introspects live ClickHouse and writes a chkit schema file.

Useful flags:

- `--out-file <path>` — Override output file path.
- `--database <name>` — Filter to databases (comma-separated or repeated).
- `--dryrun` — Preview output without writing.
- `--force` / `--overwrite` — Overwrite existing output file.

Exit codes: 0 (success), 1 (runtime error), 2 (config error).

## Generated output format

The plugin produces a TypeScript module that imports builders from `@chkit/core` and exports a default schema.

```ts
import { schema, table, view, materializedView } from '@chkit/core'

// Pulled from live ClickHouse metadata via chkit plugin pull schema

const app_events = table({
  database: "app",
  name: "events",
  engine: "MergeTree()",
  columns: [
    { name: "id", type: "UInt64" },
    { name: "received_at", type: "DateTime64(3)", default: "fn:now64(3)" },
  ],
  primaryKey: ["id"],
  orderBy: ["id"],
  partitionBy: "toYYYYMM(received_at)",
})

const app_events_view = view({
  database: "app",
  name: "events_view",
  as: "SELECT id FROM app.events",
})

const app_events_mv = materializedView({
  database: "app",
  name: "events_mv",
  to: { database: "app", name: "events_rollup" },
  as: "SELECT id, count() AS c FROM app.events GROUP BY id",
})

export default schema(app_events, app_events_view, app_events_mv)
```

Tables may also include `uniqueKey`, `ttl`, `settings`, `indexes`, and `projections` when present in the source metadata.

## Current limits

- Materialized views without a `TO` clause are skipped.
- Requires a live ClickHouse connection.
