# chkit

**ClickHouse schema and migration CLI for TypeScript projects.**

[![npm version](https://img.shields.io/npm/v/chkit?label=npm)](https://www.npmjs.com/package/chkit)
[![CI](https://github.com/obsessiondb/chkit/actions/workflows/ci.yml/badge.svg)](https://github.com/obsessiondb/chkit/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-chkit.obsessiondb.com-blue)](https://chkit.obsessiondb.com)

Define your ClickHouse tables, views, and materialized views in TypeScript. chkit diffs your schema, generates migration SQL, applies it safely, and keeps your dev and production databases in sync -- all from the command line.

> **Status: beta.** chkit powers production workloads and the CLI surface and schema DSL are stable. We may still make small breaking changes to UX and internal APIs before 1.0.

## Key Features

- **TypeScript-native schema definitions** -- tables, views, materialized views
- **Automatic migration generation** -- diff-based SQL from your schema changes
- **Safe migration execution** -- preview first, destructive-operation blocking
- **Schema drift detection** -- compare live database to expected state
- **CI gate command** -- `chkit check` fails your build on pending migrations or drift
- **TypeScript codegen** -- row types and optional Zod schemas from your schema
- **Plugin system** -- pull, codegen, backfill, or write your own
- **JSON output mode** -- `--json` on every command for scripting

## Quick Start

```bash
bun add -d chkit @chkit/core
bunx chkit init
```

Define a table in `src/db/schema/example.ts`:

```ts
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

Generate and apply your first migration:

```bash
bunx chkit generate --name init
bunx chkit migrate --apply
bunx chkit status
```

## Commands

| Command | Description |
|---------|-------------|
| `chkit init` | Scaffold config and example schema |
| `chkit generate` | Diff schema and generate migration SQL |
| `chkit migrate` | Preview and apply pending migrations |
| `chkit status` | Show migration counts and checksum status |
| `chkit drift` | Compare live database to expected schema |
| `chkit check` | CI gate: fail on pending/drift/mismatch |
| `chkit codegen` | Generate TypeScript types from schema |
| `chkit pull` | Pull existing ClickHouse schema to local files |

All commands support `--json` for machine-readable output. See the [full CLI reference](https://chkit.obsessiondb.com/cli/overview/) for details.

## Configuration

```ts
// clickhouse.config.ts
import { defineConfig } from '@chkit/core'
import { pull } from '@chkit/plugin-pull'
import { codegen } from '@chkit/plugin-codegen'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [
    pull({ outFile: './src/db/schema/pulled.ts' }),
    codegen({ outFile: './src/generated/chkit-types.ts' }),
  ],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: process.env.CLICKHOUSE_DB ?? 'default',
  },
})
```

See the [configuration docs](https://chkit.obsessiondb.com/configuration/overview/) for all options.

## Packages

| Package | Description |
|---------|-------------|
| [`chkit`](packages/cli) | CLI binary and command implementations |
| [`@chkit/core`](packages/core) | Schema DSL, config, and diff engine |
| [`@chkit/clickhouse`](packages/clickhouse) | ClickHouse client wrapper |
| [`@chkit/codegen`](packages/codegen) | TypeScript type generation engine |
| [`@chkit/plugin-pull`](packages/plugin-pull) | Pull live schema into local files |
| [`@chkit/plugin-codegen`](packages/plugin-codegen) | Codegen plugin for the CLI |
| [`@chkit/plugin-backfill`](packages/plugin-backfill) | Backfill plugin for data migrations |
| [`@chkit/plugin-obsessiondb`](packages/plugin-obsessiondb) | ObsessionDB integration: auto-rewrite `Shared` engines for ClickHouse targets |

## Documentation

Full documentation is available at **[chkit.obsessiondb.com](https://chkit.obsessiondb.com)**.

## ObsessionDB

chkit is built by the team behind [**ObsessionDB**](https://obsessiondb.com), a fully-managed ClickHouse database. ObsessionDB is the recommended way to run chkit in production:

- **First-party integration.** The [`@chkit/plugin-obsessiondb`](packages/plugin-obsessiondb) plugin auto-detects ObsessionDB and keeps your schema on `SharedReplacingMergeTree` / `SharedMergeTree` for managed replication — same TypeScript schema as your local ClickHouse, no manual switching.
- **No ops.** No Keeper, no replica tuning, no manual scaling.
- **Tested alongside chkit.** Every chkit release runs its E2E suite against ObsessionDB.

[Try ObsessionDB →](https://obsessiondb.com)

## Community

- [@ObsessionDB on X](https://x.com/ObsessionDB) — release notes and updates
- [GitHub Issues](https://github.com/obsessiondb/chkit/issues) — bugs and feature requests

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
