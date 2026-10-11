# chkit

**ClickHouse schema management in TypeScript, with Python support in alpha.**

[![npm version](https://img.shields.io/npm/v/chkit?label=npm)](https://www.npmjs.com/package/chkit)
[![CI](https://github.com/obsessiondb/chkit/actions/workflows/ci.yml/badge.svg)](https://github.com/obsessiondb/chkit/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-chkit.obsessiondb.com-blue)](https://chkit.obsessiondb.com)

chkit is an open-source toolkit for defining ClickHouse schemas in code, generating SQL migrations, and keeping databases in sync with version-controlled definitions. Review the SQL before applying it, then check migration state and schema drift from the terminal or CI.

[Get started](https://chkit.obsessiondb.com/getting-started/) · [First-schema tutorial](https://chkit.obsessiondb.com/tutorials/first-schema/) · [Documentation](https://chkit.obsessiondb.com)

## TL;DR

**Define → generate → preview → migrate → check.** Keep tables, views, materialized views, and dictionaries alongside application code. chkit diffs definitions against the previous snapshot and writes reviewable migration files. Apply those files to ClickHouse, then use `chkit check` to detect pending migrations, modified migration checksums, and live schema drift.

Use TypeScript with `chkit` and `@chkit/core`, or the alpha Python implementation with [`chkit-py`](https://chkit.obsessiondb.com/python/overview/). Both workflows use the same migration SQL, snapshots, and ClickHouse journal.

## Why chkit

- **Schema as code.** Define ClickHouse-native types, engines, sorting keys, partitions, views, and dictionaries in TypeScript or Python.
- **Reviewable migrations.** Generate timestamped SQL files from schema changes, with rename metadata and operation risk levels.
- **Controlled deployment.** Preview pending migrations, apply reviewed SQL, and track completed statements in the migration journal.
- **Drift checks in CI.** Catch pending migrations, checksum mismatches, and out-of-band changes with `chkit check`.
- **Adopt an existing database.** Pull a live ClickHouse schema into local definitions with `@chkit/plugin-pull`.
- **Extend the schema workflow.** Generate TypeScript row types and Zod schemas, or use the beta backfill plugin to update stored data after schema changes.

## A first schema

In a TypeScript project, install the CLI and schema DSL:

```sh
bun add -d chkit @chkit/core
```

Create `clickhouse.config.ts`. Set `CLICKHOUSE_URL` to a development ClickHouse endpoint, with `CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD` if required. This example manages a table in the `default` database.

```ts
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

### 1. Define

Create `src/db/schema/events.ts`:

```ts
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

### 2. Generate and review

```sh
bunx chkit generate --name create-events
```

Open the generated SQL under `chkit/migrations/`. The first migration creates the table; subsequent migrations describe changes from the previous snapshot. Commit the schema, migration files, and `chkit/meta/` together.

### 3. Preview and migrate

```sh
bunx chkit migrate --json

# After reviewing the SQL and pending migration plan:
bunx chkit migrate --apply
```

Without `--apply`, JSON mode prints the plan without applying migrations. Destructive operations require explicit approval; see the [migration workflow](https://chkit.obsessiondb.com/guides/migration-workflow/).

### 4. Check and repeat

```sh
bunx chkit status
bunx chkit check
```

Change a definition, generate another migration, review it, and apply it. Run `chkit check` in CI to verify migration state and the live schema. Use `chkit drift` for a detailed schema comparison.

For a complete walkthrough with inserts, queries, and a schema change, follow the [first-schema tutorial](https://chkit.obsessiondb.com/tutorials/first-schema/). It also covers claiming a free ObsessionDB development instance. To scaffold a ready-made project, run `bun create chkit@latest my-app --example hello` or start from [`examples/hello`](examples/hello).

## Python (alpha)

Python support is in alpha. Install [`chkit-py`](https://pypi.org/project/chkit-py/) and initialize a project:

```sh
pip install chkit-py
chkit init
```

Define schemas in Python modules and configure the connection in `clickhouse.config.py`. Use the same `generate`, `migrate`, `status`, `drift`, and `check` commands as the TypeScript workflow. See the [Python overview](https://chkit.obsessiondb.com/python/overview/) and [`chkit_python/`](chkit_python).

## Documentation

| Goal | Start here |
| --- | --- |
| Manage a new schema | [Getting started](https://chkit.obsessiondb.com/getting-started/) |
| Adopt an existing database | [Pull a live schema](https://chkit.obsessiondb.com/plugins/pull/) |
| Define tables and views | [Schema DSL reference](https://chkit.obsessiondb.com/schema/dsl-reference/) |
| Deploy migrations in CI | [CI/CD integration](https://chkit.obsessiondb.com/guides/ci-cd/) |
| Generate application types | [TypeScript codegen](https://chkit.obsessiondb.com/plugins/codegen/) |
| Recompute stored data | [SQL backfills (beta)](https://chkit.obsessiondb.com/plugins/backfill/) |
| Work with a coding agent | [Agent skills](https://chkit.obsessiondb.com/ai-agents/) |

See the [CLI reference](https://chkit.obsessiondb.com/cli/overview/) for commands, flags, and JSON output.

## Packages

| Package | Description |
| --- | --- |
| [`chkit`](packages/cli) | CLI for the schema and migration workflow |
| [`@chkit/core`](packages/core) | TypeScript schema DSL, configuration, and diff engine |
| [`@chkit/plugin-pull`](packages/plugin-pull) | Pull a live schema into local definitions |
| [`@chkit/plugin-codegen`](packages/plugin-codegen) | Generate TypeScript row types and Zod schemas |
| [`@chkit/plugin-backfill`](packages/plugin-backfill) | Checkpointed SQL backfills for data migrations (beta) |
| [`@chkit/plugin-obsessiondb`](packages/plugin-obsessiondb) | Connect to ObsessionDB and run schema commands remotely |

`@chkit/clickhouse` and `@chkit/codegen` are internal packages used by the CLI. Install matching versions of the CLI, core, and plugins; the public API is still evolving before 1.0.

## ObsessionDB

The [ObsessionDB](https://obsessiondb.com) team builds chkit and provides a managed ClickHouse service. Use chkit with self-hosted ClickHouse, ClickHouse Cloud, or ObsessionDB. The [`@chkit/plugin-obsessiondb`](packages/plugin-obsessiondb) plugin connects to managed services, and the release pipeline runs its E2E suite against ObsessionDB.

## chkit Sync (beta)

We're also building **chkit Sync**, a beta toolkit for syncing data from business applications into ClickHouse. It builds on chkit's schema management and has its own [Sync documentation](https://chkit.obsessiondb.com/sync/).

## Community

- [@ObsessionDB on X](https://x.com/ObsessionDB): release notes and updates
- [GitHub Issues](https://github.com/obsessiondb/chkit/issues): bugs and feature requests

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
