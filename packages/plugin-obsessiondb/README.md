# @chkit/plugin-obsessiondb

[ObsessionDB](https://obsessiondb.com) companion plugin for chkit. This plugin is designed for [ObsessionDB](https://obsessiondb.com) users who also need to target regular ClickHouse instances (e.g. local development, self-hosted staging).

Part of the [chkit](https://github.com/obsessiondb/chkit) monorepo. This plugin extends the [`chkit`](https://www.npmjs.com/package/chkit) CLI so one set of schema files works against both ObsessionDB and regular ClickHouse.

## Features

- **`storage_policy` stripping** -- Removes the `storage_policy` table setting, whose ObsessionDB policies (e.g. `'s3'`) don't exist on a regular ClickHouse server, when targeting non-ObsessionDB instances
- **Host auto-detection** -- Inspects `clickhouse.url` to determine whether the target is ObsessionDB or regular ClickHouse, no manual configuration needed
- **CLI flag overrides** -- `--force-shared-engines` and `--no-shared-engines` flags to override auto-detection for a single `generate` or `snapshot rebuild` run
- **Applied by `generate` and `snapshot rebuild`** -- `migrate`, `status`, `drift`, and `check` work from the migration files and snapshot those commands write
- **Views and materialized views are untouched** -- Only table definitions are rewritten

## Why

ObsessionDB uses `Shared` engine variants (e.g. `SharedReplacingMergeTree`, `SharedMergeTree`) to deliver managed replication without operator intervention. These engines don't exist in regular ClickHouse, so chkit always writes the standard engine name (`SharedReplacingMergeTree(ts)` becomes `ENGINE = ReplacingMergeTree(ts)`) and ObsessionDB substitutes the `Shared` variant on the server.

`storage_policy` is a standard ClickHouse table setting, but the storage policies ObsessionDB provides, such as `'s3'`, are not defined on a regular ClickHouse server, so `CREATE TABLE` fails there with `Unknown storage policy`. This plugin intercepts schema definitions before the diff/planning pipeline and strips `storage_policy`, whatever its value, when the target is not ObsessionDB, so you can use a single set of schema files across both ObsessionDB and regular ClickHouse.

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

The rewrite runs automatically whenever `generate` or `snapshot rebuild` loads the schema.

## How it works

1. **Auto-detection** (default): The plugin inspects your `clickhouse.url` config value. If the host is an ObsessionDB instance (`.obsessiondb.com` or `obsession.numia-dev.com`), `storage_policy` is kept. Otherwise, it is stripped.

2. **Force flags**: Override auto-detection for a single `generate` or `snapshot rebuild` run:
   - `--force-shared-engines` -- Keep `storage_policy`, even when the URL is not recognized as ObsessionDB (e.g. a service behind a custom domain)
   - `--no-shared-engines` -- Strip `storage_policy`, even on ObsessionDB

   If both are passed, `--force-shared-engines` wins. The migration files and `snapshot.json` keep what the flag decided, so pass the same flag on every `generate` and `snapshot rebuild` for that target. `migrate`, `status`, `drift`, and `check` accept both flags but ignore them.

### Examples

```bash
# Auto-detect based on clickhouse.url (default behavior)
bunx chkit generate

# Strip storage_policy even when targeting ObsessionDB
bunx chkit generate --no-shared-engines

# Keep it for an ObsessionDB service behind a custom domain
bunx chkit generate --force-shared-engines
bunx chkit snapshot rebuild --force-shared-engines
```

### What gets rewritten

| Schema | Generated DDL (every target) |
|---|---|
| `engine: 'SharedMergeTree'` | `ENGINE = MergeTree()` |
| `engine: 'SharedReplacingMergeTree(ts)'` | `ENGINE = ReplacingMergeTree(ts)` |
| `engine: 'SharedAggregatingMergeTree'` | `ENGINE = AggregatingMergeTree()` |
| `engine: 'MergeTree'` | `ENGINE = MergeTree()` |

| Table setting | Regular ClickHouse | ObsessionDB |
|---|---|---|
| `storage_policy` (any value) | stripped | kept |
| Any other setting | kept | kept |

Only table definitions are affected. Views and materialized views are passed through unchanged.

## Documentation

See the [chkit documentation](https://chkit.obsessiondb.com).

## License

[MIT](../../LICENSE)
