# chkit

**Manage ClickHouse schemas and sync API data.**

chkit is an open-source CLI for ClickHouse. Review migration SQL before applying it. Keep table definitions and TypeScript API readers in your repository, alongside the code that uses them. Run the CLI from the terminal or CI.

Use [chkit-py](https://pypi.org/project/chkit-py/) for schema and migration workflows in Python. API ingestion requires TypeScript.

[See the six-step walkthrough](https://chkit.obsessiondb.com/#from-a-schema-to-a-working-data-sync) · [Get started](https://chkit.obsessiondb.com/getting-started/) · [Build a source](https://chkit.obsessiondb.com/ingestion/quickstart/)

## Features

- **Schema-as-code** -- Define tables, views, and materialized views in TypeScript using a declarative DSL
- **Automatic migration generation** -- Diff your schema changes and generate timestamped SQL migrations with rename detection
- **Migration risk checks** -- Review risk levels and confirm destructive operations before applying them
- **Drift detection** -- Compare your local schema against a live ClickHouse instance to catch out-of-band changes
- **CI gate** -- Run `chkit check` to fail builds on pending migrations, checksum mismatches, or schema drift
- **TypeScript codegen** -- Generate row types and optional Zod schemas from your schema definitions (`@chkit/plugin-codegen`)
- **Schema pulling** -- Introspect an existing ClickHouse database into local schema files (`@chkit/plugin-pull`)
- **API ingestion** -- Define source readers against schema-managed tables, with batching, request retries, and journaled incremental checkpoints (`@chkit/plugin-ingest`)
- **Data backfill** -- Time-windowed, checkpointed backfill operations with retry logic (`@chkit/plugin-backfill`)
- **JSON output** -- Every command supports `--json` for scripting and automation

## Install

```sh
bun add -d chkit @chkit/core
```

`@chkit/core` provides the `table()` / schema DSL your `*.schema.ts` files import, so it is required alongside the CLI.

## Usage

```sh
# Scaffold a new project
bunx chkit init

# Generate a migration from schema changes
bunx chkit generate --name add-users-table

# Preview and apply pending migrations
bunx chkit migrate --apply

# Check migration status
bunx chkit status

# Detect schema drift
bunx chkit drift

# CI gate (fails on pending migrations or drift)
bunx chkit check
```

All commands support `--json` for machine-readable output and `--config <path>` to specify a custom config file.

## Add data ingestion

Install `@chkit/plugin-ingest` at the same version as the CLI and core, register `ingest()` in the config, and export tables and pipelines from a TypeScript entry file. A stream pairs a destination table with an async reader. Keep raw objects for flexible SQL transformations, or map records into known columns.

```sh
bunx chkit ingest list
bunx chkit ingest run --tag pipeline:content
bunx chkit ingest status
```

Runs are finite; use an external scheduler and serialize processes per target. The [ingestion quickstart](https://chkit.obsessiondb.com/ingestion/quickstart/) includes a complete public-API example and config.

## Requirements

- **Node 20+** or **Bun**: chkit loads your TypeScript config and schema files on both runtimes.
- **ClickHouse 24.x or newer**: chkit targets recent ClickHouse (self-hosted, ClickHouse Cloud, or ObsessionDB). Some schema features are version-gated; see [ClickHouse compatibility](https://chkit.obsessiondb.com/guides/clickhouse-compatibility/).

## Plugins

| Plugin | Description |
|--------|-------------|
| [`@chkit/plugin-codegen`](https://www.npmjs.com/package/@chkit/plugin-codegen) | Generate TypeScript row types and Zod schemas |
| [`@chkit/plugin-pull`](https://www.npmjs.com/package/@chkit/plugin-pull) | Pull schemas from a live ClickHouse instance |
| [`@chkit/plugin-ingest`](https://www.npmjs.com/package/@chkit/plugin-ingest) | API ingestion with batching, retries, and journaled checkpoints |
| [`@chkit/plugin-backfill`](https://www.npmjs.com/package/@chkit/plugin-backfill) | Time-windowed data backfill with checkpoints |
| [`@chkit/plugin-obsessiondb`](https://www.npmjs.com/package/@chkit/plugin-obsessiondb) | Auto-rewrite Shared engines for ObsessionDB compatibility |

## AI Agent Skill

Install the chkit agent skill so AI coding assistants understand chkit:

```sh
npx skills add obsessiondb/chkit --skill chkit
# For API source authoring:
npx skills add obsessiondb/chkit --skill chkit-ingestion
```

## Documentation

See the [chkit documentation](https://chkit.obsessiondb.com).

## Versioning & releases

chkit is **pre-1.0**. While the version is `0.x`, the public API is still
stabilizing and **any release may contain breaking changes**. This is the
standard [SemVer](https://semver.org/#spec-item-4) `0.x` contract. Pin an exact
version (or a tight range) if you need reproducible installs.

- **`latest` tracks the current beta line.** Until 1.0 ships, installing
  `chkit` with no tag (`bun add -d chkit`) gives you the latest `0.1.0-beta.x`
  build.
- **All publishable packages release in lockstep.** `chkit`, `create-chkit`,
  and the `@chkit/*` packages share a version. Install matching CLI, core,
  and plugin versions.
- **Public vs. internal surface.** The supported public API is the `chkit` CLI,
  `@chkit/core`, and the `@chkit/plugin-*` packages. `@chkit/clickhouse` and
  `@chkit/codegen` are internal and not meant to be installed directly.
- **At 1.0** chkit will follow SemVer (breaking changes only in major
  bumps) and a deprecation policy. Until then, treat minor/patch bumps as
  potentially breaking.

## License

[MIT](../../LICENSE)

---

The [**ObsessionDB**](https://obsessiondb.com) team builds and maintains chkit. Connect to its managed ClickHouse service with [`@chkit/plugin-obsessiondb`](https://www.npmjs.com/package/@chkit/plugin-obsessiondb).
