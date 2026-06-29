---
title: "Configuration Overview"
description: "clickhouse.config.ts structure and defaults."
---

`chkit` is configured through `clickhouse.config.ts`.

## Core Fields

- `schema`: glob path to [schema files](/schema/dsl-reference/)
- `outDir`: root folder for generated artifacts
- `migrationsDir`: SQL migration file folder
- `metaDir`: state folder (`snapshot.json`)
- `plugins`: plugin registrations
- `clickhouse`: live connection options
- `check`: CI gate behavior
- `safety`: destructive migration safety behavior

Migration state (the journal of applied migrations) is not stored in `metaDir`. It lives in the `_chkit_migrations` table in your configured `clickhouse.database`, so `status`, `migrate`, and `check` require a ClickHouse connection.

## Example

```ts
import { defineConfig } from '@chkit/core'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  migrationsDir: './chkit/migrations',
  metaDir: './chkit/meta',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: process.env.CLICKHOUSE_DB ?? 'default',
  },
})
```

## Cluster mode (`ON CLUSTER`)

For self-managed multi-node ClickHouse clusters, set `clickhouse.cluster` to the cluster name from your server's `remote_servers` config:

```ts
clickhouse: {
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:9000',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
  database: 'default',
  cluster: 'my_cluster',
},
```

When `cluster` is set, chkit:

- emits every generated DDL statement with an `ON CLUSTER <name>` clause, so `generate` bakes it into the migration files and `migrate` propagates each change to all nodes via ClickHouse's distributed DDL queue, and
- creates its migration journal (`_chkit_migrations`) as a `ReplicatedReplacingMergeTree`, keeping applied-migration history consistent across every node — so running `migrate` against a load-balanced endpoint never re-applies migrations.

chkit does **not** rewrite your table engines: declare `ReplicatedMergeTree` (or another `Replicated*`/`Shared*` variant) yourself for tables whose data should replicate. Empty-argument engines (e.g. `ENGINE = ReplicatedMergeTree`) are recommended so the server's `default_replica_path` supplies a collision-free Keeper path, which also keeps drop-and-recreate safe.

Leave `cluster` unset for single-node servers, ClickHouse Cloud, or ObsessionDB, where replication is automatic (SharedMergeTree) and `ON CLUSTER` is unnecessary. The value accepts an identifier (`my_cluster`) or a macro (`{cluster}`) when your nodes define one.

## User profile config fallback

Project-scoped commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) always require a project config in the working directory.

[`chkit query`](/cli/query/) is the exception: when no project config is found, chkit falls back to a user-profile config at `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). This lets ad-hoc queries run from any directory. If ObsessionDB credentials are present (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config automatically, so `chkit query` works after `chkit obsessiondb login` without a local config file at all.
