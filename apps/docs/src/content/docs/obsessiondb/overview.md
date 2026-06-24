---
title: ObsessionDB Overview
description: First-class integration with ObsessionDB — engine rewriting, service selection, and remote execution from one schema.
sidebar:
  order: 1
---

chkit ships a dedicated integration with [ObsessionDB](https://obsessiondb.com), the managed ClickHouse-compatible database that provides `Shared` engine variants and a hosted API for queries and backfills.

## What it gives you

- **Zero-copy onboarding** — claim a free dev instance or sign up with a one-time email code straight from `chkit init` or the CLI, no URLs or tokens to paste.
- **One schema, two targets** — write `Shared*` engines once and run them against ObsessionDB as-is, or against regular ClickHouse with the `Shared` prefix stripped automatically.
- **Service selection** — list services across your organizations, pick a default per project, and override per command without touching config.
- **Remote query execution** — once a service is selected, `chkit query` and other SQL-emitting commands route through the ObsessionDB API instead of a local ClickHouse connection.
- **Remote backfills** — `chkit backfill` can submit jobs to ObsessionDB rather than streaming chunks from your machine.

## Install

```sh
bun add -d @chkit/plugin-obsessiondb
```

Register it in your `clickhouse.config.ts`:

```ts
import { defineConfig } from '@chkit/core'
import { obsessiondb } from '@chkit/plugin-obsessiondb'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [obsessiondb()],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  },
})
```

The plugin hooks into `generate`, `migrate`, `status`, `drift`, `check`, and `query`.

## Next

- [Getting Started](/obsessiondb/getting-started/) — sign up, authenticate, and select your first service.
- [Engine Rewriting](/obsessiondb/engine-rewriting/) — how `Shared*` engines are stripped for non-ObsessionDB targets.
- [Services](/obsessiondb/services/) — list, select, alias, and override services per command.
- [Backfill Plugin](/plugins/backfill/) — for backfills against ObsessionDB once a service is selected.
