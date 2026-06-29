---
title: "Tutorial: your first schema"
description: Build a chkit project from an empty folder — migrate the starter table to a live database, insert and query rows, then evolve the schema.
sidebar:
  order: 1
---

A hands-on walkthrough from an empty folder to a live, version-controlled table. You'll scaffold a chkit project, deploy the starter `events` table it generates, put data in it, query it back, then add a column and ship the change — the full chkit loop, start to finish.

Every step is a real command. Run them in order and you'll end with a working project you can keep building on.

## What you'll need

- Node.js 20+ or Bun 1.3.5+
- An email inbox you can reach

No ClickHouse to install: this tutorial claims a free ObsessionDB dev instance straight from the CLI. The commands use `bun`; `npm`, `pnpm`, and `yarn` work the same way.

## 1. Create the project

Start in a new, empty folder and run `chkit init`:

```sh
mkdir chkit-tutorial
cd chkit-tutorial
bunx chkit@latest init
```

In an empty directory, `init` does the full bootstrap: it writes `clickhouse.config.ts` and a starter schema at `src/db/schema/example.ts`, creates a `package.json`, and installs `chkit`, `@chkit/core`, and `@chkit/plugin-obsessiondb` so the project is runnable.

It then shows the connect prompt:

```
Claim a free ObsessionDB dev instance   email code, ready in seconds
I already have an ObsessionDB account    log in and pick a service
I already have a ClickHouse instance     connect with env vars
Configure later
```

Choose **Claim a free ObsessionDB dev instance**, enter your email, and paste the 6-digit code from your inbox. chkit creates a personal organization, provisions a free instance, selects it (written to `.chkit/obsessiondb.json`), and registers the ObsessionDB plugin in your config.

:::note
Already run your own ClickHouse? Pick **I already have a ClickHouse instance** instead and set `CLICKHOUSE_URL`. Every command below works the same against a direct ClickHouse — see [Getting Started with ObsessionDB](/obsessiondb/getting-started/) for the alternatives.
:::

Confirm the connection works:

```sh
bunx chkit query "SELECT 1"
```

A single row back means you're connected.

## 2. Look at the starter schema

`init` scaffolded a table for you at `src/db/schema/example.ts` — an `events` table that's a good shape for ingesting application or analytics events:

```ts
// src/db/schema/example.ts
import { schema, table } from '@chkit/core'

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
  partitionBy: 'toYYYYMM(ingested_at)',
})

export default schema(events)
```

A `table()` definition maps directly to a ClickHouse `CREATE TABLE`: a `MergeTree` engine, three columns, ordered by `id`, and partitioned by month. `ingested_at` carries `default: 'fn:now64(3)'`, so the database fills it in automatically. The types here (`UInt64`, `String`, `DateTime64(3)`) are ClickHouse-native; see the [Schema DSL reference](/schema/dsl-reference/) for the full type system and table options.

Use it as-is for now — you'll change it later.

## 3. Generate the migration

`chkit generate` diffs your schema against the previous snapshot and writes migration SQL. There's no snapshot yet, so this produces a `CREATE TABLE`:

```sh
bunx chkit generate --name create_events
```

Open the file it wrote under `chkit/migrations/` — chkit shows you the exact SQL before anything is applied:

```sql
-- operation: create_table key=table:default.events risk=safe
CREATE TABLE default.events
(
  id UInt64,
  source String,
  ingested_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ingested_at)
ORDER BY id;
```

## 4. Apply it

```sh
bunx chkit migrate --apply
```

This runs the pending migration against the instance you claimed and records it in the migration journal.

## 5. Verify the table exists

Check migration state, confirm the live schema matches your code, and look at the table directly:

```sh
bunx chkit status
bunx chkit check
bunx chkit query "DESCRIBE events"
```

`status` lists the applied migration, `check` confirms the database matches your TypeScript definitions, and `DESCRIBE` shows the live columns.

:::caution
ClickHouse and ObsessionDB DDL is eventually consistent — it isn't instant. If `status` or `check` runs immediately after `migrate --apply`, give it a moment and re-run so it doesn't race the cluster.
:::

## 6. Insert and query rows

The table is empty. Put a couple of rows in with `chkit query` — `ingested_at` is left out, so the database fills it from its default:

```sh
bunx chkit query "INSERT INTO events (id, source) VALUES (1, 'web'), (2, 'mobile')"
```

Then read them back:

```sh
bunx chkit query "SELECT count() FROM events"
bunx chkit query "SELECT id, source, ingested_at FROM events ORDER BY id"
```

You now have a schema in code and matching data in a live database.

## 7. Evolve the schema

Schemas change. Add a `level` column to the `events` table in `src/db/schema/example.ts`:

```ts
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'source', type: 'String' },
    { name: 'level', type: 'String' },
    { name: 'ingested_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
  ],
```

Generate a migration for the change and review it — this time it's an `ALTER TABLE`, not a recreate:

```sh
bunx chkit generate --name add_level_column
```

```sql
-- operation: add_column key=table:default.events risk=safe
ALTER TABLE default.events ADD COLUMN level String AFTER source;
```

Apply it and confirm the column landed:

```sh
bunx chkit migrate --apply
bunx chkit check
bunx chkit query "DESCRIBE events"
```

`check` passes again, and `DESCRIBE` now lists `level`. That's the whole chkit loop: **edit the schema → `generate` → review the SQL → `migrate` → verify** — repeat it for every change from here on.

## Where to next

- [The CLI reference](/cli/overview/) — every command and flag used above
- [Schema DSL reference](/schema/dsl-reference/) — columns, engines, views, and materialized views
- [Configuration](/configuration/overview/) — what `clickhouse.config.ts` controls
- [Getting Started with ObsessionDB](/obsessiondb/getting-started/) — other ways to connect, and non-interactive setup
- [CI/CD integration](/guides/ci-cd/) — run `generate`, `migrate`, and `check` in a pipeline
