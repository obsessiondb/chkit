---
title: ObsessionDB Plugin
description: Run a single set of schema files across both ObsessionDB and regular ClickHouse by auto-rewriting Shared engine variants.
---

The `@chkit/plugin-obsessiondb` plugin lets you keep one set of schema files
that target both [ObsessionDB](https://obsessiondb.com) and standard ClickHouse
instances (e.g. local Docker, self-hosted staging).

## Why

ObsessionDB uses `Shared` engine variants
(`SharedMergeTree`, `SharedReplacingMergeTree`, `SharedAggregatingMergeTree`)
to deliver managed replication without operator intervention. These engines
do not exist in regular ClickHouse. If you define schemas with `Shared`
engines but apply them against a standard ClickHouse instance, migrations
will fail.

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

The plugin hooks into `generate`, `migrate`, `status`, `drift`, `check`, and `query`.

## Service selection

Authenticate and pick the ObsessionDB service this project should route through:

```bash
chkit obsessiondb login
chkit obsessiondb service list
chkit obsessiondb service select
```

The selection is stored in `.chkit/obsessiondb.json` next to your config file and used as the default target for every command after that.

### Per-command service override

Once authenticated, any command that hits ClickHouse accepts `--service <name-or-alias>` to target a different service for one invocation without changing the saved selection. The flag takes the service **name** as shown in `chkit obsessiondb service list`, or a saved alias.

```bash
# Run an ad-hoc query against a different service
chkit query "SELECT count() FROM users" --service customer-b

# Apply migrations against a one-off service
chkit migrate --apply --service staging
```

`--service` is available on `generate`, `migrate`, `status`, `drift`, `check`, and `query`. The lookup tries service names first, then saved aliases, and fails fast with the list of available services and aliases if nothing matches.

### Service aliases

Aliases are stored with the ObsessionDB service selection: project aliases live in `.chkit/obsessiondb.json` next to your config, while profile-mode aliases live in `~/.config/chkit/obsessiondb.json`.

```bash
# Define a short alias for a service name
chkit obsessiondb service alias set prod customer-production

# Use the alias in a query
chkit query "SELECT count() FROM users" --service prod

# List or remove aliases
chkit obsessiondb service alias list
chkit obsessiondb service alias remove prod
```

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
