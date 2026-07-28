---
title: Pull Plugin
description: Introspect live ClickHouse tables, views, materialized views, and dictionaries and generate chkit schema files.
sidebar:
  order: 3
---

This document covers practical usage of the optional `pull` plugin.

## What it does

- Connects to a live ClickHouse instance and introspects table metadata (columns, engines, indexes, projections, partitioning, TTL, settings).
- Introspects views and materialized views (including `TO` clause parsing).
- Introspects dictionaries (attributes — including `HIERARCHICAL`/`BIDIRECTIONAL`/`INJECTIVE`/`IS_OBJECT_ID` modifiers — primary key, `SOURCE`/`LAYOUT`/`LIFETIME`/`RANGE`/`SETTINGS`), preserving ClickHouse's `[HIDDEN]` password redaction — see [Credential handling](#credential-handling-hidden-passwords).
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

## Credential handling (`[HIDDEN]` passwords)

By default, ClickHouse redacts inline `SOURCE(...)` passwords to `[HIDDEN]` on introspection (`system.tables.create_table_query`, `SHOW CREATE DICTIONARY`), and chkit does not attempt to work around that. When a pulled dictionary's `source` contains `[HIDDEN]`, `chkit pull` prints a console warning (and includes it in a `warnings` array in `--json` output), and the generated file emits the source verbatim with a leading comment:

```ts
// NOTE: password redacted by ClickHouse — replace '[HIDDEN]' with your credential (e.g. process.env.X).
const default_users_dict = dictionary({
  database: "default",
  name: "users_dict",
  attributes: [
    { name: "id", type: "UInt64" },
    { name: "name", type: "String" },
  ],
  primaryKey: ["id"],
  source: "MYSQL(host 'db' port 3306 user 'reader' password '[HIDDEN]' db 'app' table 'users')",
  layout: "HASHED()",
  lifetime: "300",
})
```

Replace `[HIDDEN]` with a real credential — typically an environment-variable interpolation, matching how you'd author the dictionary by hand (see [Credentials in `source`](/schema/dsl-reference/#credentials-in-source)):

```ts
source: `MYSQL(host 'db' port 3306 user 'reader' password '${process.env.MYSQL_PASSWORD}' db 'app' table 'users')`,
```

For round-trip fidelity without a manual edit, use [named collections](https://clickhouse.com/docs/operations/named-collections) on the ClickHouse side instead of an inline password — chkit does not require this, but it's the ClickHouse-native way to avoid the redaction entirely.

Because a `source` still carrying `[HIDDEN]` is excluded from the diff entirely (see [Credentials in `source`](/schema/dsl-reference/#credentials-in-source)), `chkit generate` won't produce a migration for that dictionary's `source` until you replace the placeholder with a real value.

### Recovering the real password instead

ClickHouse can be configured to skip the redaction and hand back the real password on introspection: enable the server-side `display_secrets_in_show_and_select` setting and grant the connecting user `displaySecretsInShowAndSelect`. The `[HIDDEN]` warning mentions this escape hatch.

If you do this, be aware of the consequence: `chkit pull` has no way to detect that this is happening, or to re-redact the value on your behalf — it just copies through whatever ClickHouse returns. The real password lands in the generated schema file in plain text, same as any dictionary you'd author by hand with an inline credential. `chkit pull` detects this case too and warns that a plain-text password was written to the file, so you don't discover it by accident later.

## Current limits

- Materialized views without a `TO` clause are skipped.
- Dictionaries whose `create_table_query` can't be parsed (attributes, primary key, or `SOURCE`/`LAYOUT`/`LIFETIME` missing) are skipped.
- XML-config dictionaries (not created via DDL) are not introspected.
- Requires a live ClickHouse connection.
