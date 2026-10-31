# chkit

**ClickHouse schema management in TypeScript, with Python support in beta.**

chkit is an open-source CLI for defining ClickHouse schemas in code, generating SQL migrations, and checking schema drift. Keep definitions and migration files in your repository, review the SQL before applying it, and verify the live database from the terminal or CI.

[Get started](https://chkit.obsessiondb.com/getting-started/) · [First-schema tutorial](https://chkit.obsessiondb.com/tutorials/first-schema/) · [Documentation](https://chkit.obsessiondb.com)

## TL;DR

**Define → generate → preview → migrate → check.** TypeScript schemas use `@chkit/core`. Python support is in beta and uses [`chkit-py`](https://pypi.org/project/chkit-py/), with the same migration SQL, snapshots, and ClickHouse journal.

## Features

- **Schema as code** — Define tables, views, materialized views, and dictionaries with ClickHouse-native types and options.
- **Migration generation** — Diff definitions against the previous snapshot and generate timestamped SQL migrations with rename metadata.
- **Migration risk checks** — Review risk levels and approve destructive operations before applying them.
- **Drift detection** — Compare the schema snapshot against a live ClickHouse instance to catch out-of-band changes.
- **CI gate** — Run `chkit check` to fail builds on pending migrations, checksum mismatches, or schema drift.
- **TypeScript codegen** — Generate row types and optional Zod schemas with `@chkit/plugin-codegen`.
- **Schema pulling** — Import a live ClickHouse schema into local files with `@chkit/plugin-pull`.
- **Data backfill (beta)** — Run checkpointed SQL backfills for data migrations with `@chkit/plugin-backfill`.
- **JSON output** — Use `--json` for scripting and automation.

## Install

```sh
bun add -d chkit @chkit/core
```

Install both packages: the CLI runs commands, and `@chkit/core` provides the schema DSL and config helpers imported by TypeScript projects.

## First migration

Initialize the config and starter schema:

```sh
bunx chkit init
```

Choose a database connection in the prompt, or set `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD` for an existing ClickHouse instance. Edit the starter definition in `src/db/schema/example.ts` to match the intended table, then run the schema workflow:

```sh
# Generate SQL from the schema definitions
bunx chkit generate --name create-events

# Review chkit/migrations/*.sql, then preview pending migrations
bunx chkit migrate --json

# Apply the reviewed migrations
bunx chkit migrate --apply

# Verify migration state and the live schema
bunx chkit status
bunx chkit check
```

Without `--apply`, JSON mode only prints the pending migration plan. Commit the schema definitions, migration files, and `chkit/meta/` together. Repeat the workflow after changing a definition, and use `chkit drift` for a detailed schema comparison.

All commands support `--json` for machine-readable output and `--config <path>` for a custom config file. The [first-schema tutorial](https://chkit.obsessiondb.com/tutorials/first-schema/) includes a complete definition, database setup, queries, and a schema change.

## Python (beta)

Python support is in beta. Install the Python implementation and initialize a project:

```sh
pip install chkit-py
chkit init
```

Use Python schema modules and `clickhouse.config.py`, then run the same `generate`, `migrate`, `status`, `drift`, and `check` commands. See the [Python overview](https://chkit.obsessiondb.com/python/overview/).

## Requirements

- **Node.js 22+ or Bun 1.3.5+** for TypeScript config and schemas. Python projects require **Python 3.11+** and `chkit-py`.
- **ClickHouse 24.x or newer**, self-hosted or managed. Some schema features are version-gated; see [ClickHouse compatibility](https://chkit.obsessiondb.com/guides/clickhouse-compatibility/).

## Plugins

| Plugin | Description |
| --- | --- |
| [`@chkit/plugin-codegen`](https://www.npmjs.com/package/@chkit/plugin-codegen) | Generate TypeScript row types and Zod schemas |
| [`@chkit/plugin-pull`](https://www.npmjs.com/package/@chkit/plugin-pull) | Pull a live schema into local definitions |
| [`@chkit/plugin-backfill`](https://www.npmjs.com/package/@chkit/plugin-backfill) | Run checkpointed SQL backfills for data migrations (beta) |
| [`@chkit/plugin-obsessiondb`](https://www.npmjs.com/package/@chkit/plugin-obsessiondb) | Connect to ObsessionDB and run schema commands remotely |

Register plugins in `clickhouse.config.ts`. See the [plugin documentation](https://chkit.obsessiondb.com/plugins/overview/) for setup.

## AI agent skill

Install the schema skill for AI coding assistants:

```sh
npx skills add obsessiondb/chkit --skill chkit
```

See [Agent skills](https://chkit.obsessiondb.com/ai-agents/) for supported tools and setup.

## Versioning and releases

chkit is pre-1.0: the public API is still evolving, and releases may contain breaking changes. Pin versions for reproducible installs.

- All publishable packages release in lockstep. Install matching versions of `chkit`, `@chkit/core`, and plugins.
- The supported public API is the CLI, `@chkit/core`, and `@chkit/plugin-*`. `@chkit/clickhouse` and `@chkit/codegen` are internal packages.
- At 1.0, chkit will follow SemVer with breaking changes in major releases.

## chkit Sync (beta)

We're also building **chkit Sync**, a beta toolkit for syncing data from business applications into ClickHouse. It builds on chkit's schema management and has its own [Sync documentation](https://chkit.obsessiondb.com/sync/).

## License

[MIT](../../LICENSE)

---

The [ObsessionDB](https://obsessiondb.com) team builds and maintains chkit. Connect to its managed ClickHouse service with [`@chkit/plugin-obsessiondb`](https://www.npmjs.com/package/@chkit/plugin-obsessiondb).
