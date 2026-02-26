# chkit

ClickHouse schema and migration CLI for TypeScript projects.

Define your ClickHouse schema in TypeScript, generate migrations automatically, detect drift, and run CI checks -- all from a single CLI.

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
bun add -d chkit
```

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

## License

[MIT](../../LICENSE)

---

Sponsored by [ObsessionDB](https://obsessiondb.com)
