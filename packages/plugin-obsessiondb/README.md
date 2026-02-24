# @chkit/plugin-obsessiondb

[ObsessionDB](https://obsessiondb.com) companion plugin for chkit. This plugin is designed for [ObsessionDB](https://obsessiondb.com) users who also need to target regular ClickHouse instances (e.g. local development, self-hosted staging).

Part of the [chkit](https://github.com/obsessiondb/chkit) monorepo. This plugin extends the [`chkit`](https://www.npmjs.com/package/chkit) CLI with automatic engine rewriting.

## Features

- **Automatic `Shared` engine stripping** -- Rewrites `SharedXXXTree` engines (e.g. `SharedReplacingMergeTree`) to their standard ClickHouse equivalents when targeting non-ObsessionDB instances
- **Host auto-detection** -- Inspects `clickhouse.url` to determine whether the target is ObsessionDB or regular ClickHouse, no manual configuration needed
- **CLI flag overrides** -- `--force-shared-engines` and `--no-shared-engines` flags to override auto-detection on any command
- **Works with all schema commands** -- Hooks into `generate`, `migrate`, `status`, `drift`, and `check`
- **Views and materialized views are untouched** -- Only table engine definitions are rewritten

## Why

ObsessionDB and ClickHouse Cloud use `Shared` engine variants (e.g. `SharedReplacingMergeTree`, `SharedMergeTree`). These engines don't exist in regular ClickHouse. If you define schemas with `Shared` engines but target a standard ClickHouse instance, migrations will fail.

This plugin intercepts schema definitions before the diff/planning pipeline and strips the `Shared` prefix when needed, so you can use a single set of schema files across both ObsessionDB and regular ClickHouse.

## Install

```bash
bun add -d @chkit/plugin-obsessiondb
```

## Usage

Register the plugin in your config:

```ts
// clickhouse.config.ts
import { defineConfig } from '@chkit/core'
import { obsessiondb } from '@chkit/plugin-obsessiondb'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [
    obsessiondb(),
  ],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  },
})
```

The plugin works automatically with `generate`, `migrate`, `status`, `drift`, and `check` commands.

## How it works

1. **Auto-detection** (default): The plugin inspects your `clickhouse.url` config value. If the host is an ObsessionDB instance (`.obsessiondb.com` or `obsession.numia-dev.com`), `Shared` engines are kept as-is. Otherwise, the `Shared` prefix is stripped.

2. **Force flags**: Override auto-detection with CLI flags:
   - `--force-shared-engines` -- Keep `Shared` engine prefixes, even on regular ClickHouse
   - `--no-shared-engines` -- Strip `Shared` engine prefixes, even on ObsessionDB

### Examples

```bash
# Auto-detect based on clickhouse.url (default behavior)
bunx chkit generate

# Force stripping even when targeting ObsessionDB
bunx chkit generate --no-shared-engines

# Force keeping Shared engines even on regular ClickHouse
bunx chkit migrate --force-shared-engines
```

### Engine rewriting

| Schema engine | Regular ClickHouse | ObsessionDB |
|---|---|---|
| `SharedMergeTree` | `MergeTree` | `SharedMergeTree` |
| `SharedReplacingMergeTree(ts)` | `ReplacingMergeTree(ts)` | `SharedReplacingMergeTree(ts)` |
| `SharedAggregatingMergeTree` | `AggregatingMergeTree` | `SharedAggregatingMergeTree` |
| `MergeTree` | `MergeTree` | `MergeTree` |

Only table definitions are affected. Views and materialized views are passed through unchanged.

## Documentation

See the [chkit documentation](https://chkit.obsessiondb.com).

## License

[MIT](../../LICENSE)
