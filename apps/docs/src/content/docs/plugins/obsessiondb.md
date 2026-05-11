---
title: ObsessionDB Plugin
description: Run a single set of schema files across both ObsessionDB and regular ClickHouse by auto-rewriting Shared engine variants.
---

The `@chkit/plugin-obsessiondb` plugin lets you keep one set of schema files
that target both [ObsessionDB](https://obsessiondb.com) (and ClickHouse Cloud)
and standard ClickHouse instances (e.g. local Docker, self-hosted staging).

## Why

ObsessionDB and ClickHouse Cloud use `Shared` engine variants
(`SharedMergeTree`, `SharedReplacingMergeTree`, `SharedAggregatingMergeTree`).
These engines do not exist in regular ClickHouse. If you define schemas with
`Shared` engines but apply them against a standard ClickHouse instance,
migrations will fail.

This plugin intercepts schema definitions before diff/planning and strips the
`Shared` prefix when the target is not ObsessionDB.

## Install

```bash
bun add -d @chkit/plugin-obsessiondb
```

## Usage

Register the plugin in your `clickhouse.config.ts`:

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

The plugin hooks into `generate`, `migrate`, `status`, `drift`, and `check`.

## How it works

1. **Auto-detection (default)** — the plugin inspects `clickhouse.url`. If the
   host matches `.obsessiondb.com`, `Shared` engines are preserved. Otherwise,
   the `Shared` prefix is stripped.
2. **CLI flag overrides** — override auto-detection per command:
   - `--force-shared-engines` keeps `Shared` engine prefixes even against
     regular ClickHouse.
   - `--no-shared-engines` strips the prefix even against ObsessionDB.

## Engine rewriting

| Schema engine | Regular ClickHouse | ObsessionDB |
|---|---|---|
| `SharedMergeTree` | `MergeTree` | `SharedMergeTree` |
| `SharedReplacingMergeTree(ts)` | `ReplacingMergeTree(ts)` | `SharedReplacingMergeTree(ts)` |
| `SharedAggregatingMergeTree` | `AggregatingMergeTree` | `SharedAggregatingMergeTree` |
| `MergeTree` | `MergeTree` | `MergeTree` |

Only table engine definitions are rewritten. Views and materialized views pass
through unchanged.

## Examples

```bash
# Auto-detect based on clickhouse.url
bunx chkit generate

# Force stripping even when targeting ObsessionDB
bunx chkit generate --no-shared-engines

# Force keeping Shared engines even on regular ClickHouse
bunx chkit migrate --force-shared-engines
```
