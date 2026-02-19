# chkit

ClickHouse schema and migration CLI for TypeScript projects.

Part of the [chkit](https://github.com/obsessiondb/chkit) monorepo.

## Install

```bash
bun add -d chkit @chkit/core
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

## Documentation

See the [chkit documentation](https://chkit.obsessiondb.com).

## License

[MIT](../../LICENSE)
