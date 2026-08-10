# chkit

ClickHouse schema and migration CLI for TypeScript projects.

Define your ClickHouse schema in TypeScript, generate migrations automatically, detect drift, and run CI checks -- all from a single CLI.

Also available for Python as [chkit-py](https://pypi.org/project/chkit-py/) — same CLI, same schema semantics.

## Features

- **Schema-as-code** -- Define tables, views, and materialized views in TypeScript using a declarative DSL
- **Automatic migration generation** -- Diff your schema changes and generate timestamped SQL migrations with rename detection
- **Safe migrations** -- Destructive operations are flagged with risk levels and require explicit confirmation
- **Drift detection** -- Compare your local schema against a live ClickHouse instance to catch out-of-band changes
- **CI gate** -- Run `chkit check` to fail builds on pending migrations, checksum mismatches, or schema drift
- **TypeScript codegen** -- Generate row types and optional Zod schemas from your schema definitions (`@chkit/plugin-codegen`)
- **Schema pulling** -- Introspect an existing ClickHouse database into local schema files (`@chkit/plugin-pull`)
- **Data backfill** -- Time-windowed, checkpointed backfill operations with retry logic (`@chkit/plugin-backfill`)
- **JSON output** -- Every command supports `--json` for scripting and automation

## Install

```bash
bun add -d chkit @chkit/core
```

`@chkit/core` provides the `table()` / schema DSL your `*.schema.ts` files import, so it is required alongside the CLI.

## Usage

```bash
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

## Requirements

- **Node 20+** or **Bun** — chkit loads your TypeScript config and schema files on both runtimes.
- **ClickHouse 24.x or newer** — chkit targets recent ClickHouse (self-hosted, ClickHouse Cloud, or ObsessionDB). Some schema features are version-gated; see [ClickHouse compatibility](https://chkit.obsessiondb.com/guides/clickhouse-compatibility/).

## Plugins

| Plugin | Description |
|--------|-------------|
| [`@chkit/plugin-codegen`](https://www.npmjs.com/package/@chkit/plugin-codegen) | Generate TypeScript row types and Zod schemas |
| [`@chkit/plugin-pull`](https://www.npmjs.com/package/@chkit/plugin-pull) | Pull schemas from a live ClickHouse instance |
| [`@chkit/plugin-backfill`](https://www.npmjs.com/package/@chkit/plugin-backfill) | Time-windowed data backfill with checkpoints |
| [`@chkit/plugin-obsessiondb`](https://www.npmjs.com/package/@chkit/plugin-obsessiondb) | Auto-rewrite Shared engines for ObsessionDB compatibility |

## AI Agent Skill

Install the chkit agent skill so AI coding assistants understand chkit:

```bash
npx skills add obsessiondb/chkit
```

## Documentation

See the [chkit documentation](https://chkit.obsessiondb.com).

## Versioning & releases

chkit is **pre-1.0**. While the version is `0.x`, the public API is still
stabilizing and **any release may contain breaking changes** — this is the
standard [SemVer](https://semver.org/#spec-item-4) `0.x` contract. Pin an exact
version (or a tight range) if you need reproducible installs.

- **`latest` tracks the current beta line.** Until 1.0 ships, installing
  `chkit` with no tag (`bun add -d chkit`) gives you the latest `0.1.0-beta.x`
  build. This is intentional for the pre-1.0 period.
- **All publishable packages release in lockstep.** `chkit`, `create-chkit`,
  and every `@chkit/*` package share a single version, so a given chkit version
  always lines up with matching plugin and core versions — there is no
  cross-package version skew.
- **Public vs. internal surface.** The supported public API is the `chkit` CLI,
  `@chkit/core`, and the `@chkit/plugin-*` packages. `@chkit/clickhouse` and
  `@chkit/codegen` are internal and not meant to be installed directly.
- **At 1.0** chkit will commit to real SemVer (breaking changes only in major
  bumps) and a deprecation policy. Until then, treat minor/patch bumps as
  potentially breaking.

## License

[MIT](../../LICENSE)

---

Built and maintained by the team behind [**ObsessionDB**](https://obsessiondb.com) — fully-managed ClickHouse with a first-party chkit integration ([`@chkit/plugin-obsessiondb`](https://www.npmjs.com/package/@chkit/plugin-obsessiondb)).
