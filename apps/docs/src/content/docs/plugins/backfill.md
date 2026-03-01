---
title: Backfill Plugin
description: Plan, execute, and monitor time-windowed backfill operations with checkpointed progress and automatic retries.
---

This document covers practical usage of the optional `backfill` plugin.

## What it does

- Builds deterministic, immutable backfill plans that divide a time window into chunks.
- Executes backfills against ClickHouse with per-chunk checkpointing, automatic retries, and idempotency tokens.
- Detects materialized views and automatically generates correct CTE-wrapped replay queries.
- Supports resume from checkpoint, cancel, status monitoring, and doctor-style diagnostics.
- Integrates with [`chkit check`](/cli/check/) for CI enforcement of pending backfills.
- Persists all state as JSON/NDJSON on disk.

## How it fits your workflow

The plugin follows a plan-then-execute lifecycle:

1. `plan` — Build an immutable backfill plan dividing the time window into chunks.
2. `run` — Execute the plan with checkpointed progress.
3. `status` — Monitor chunk progress and run state.

Additional commands: `resume` (continue from checkpoint), `cancel` (stop execution), `doctor` (actionable diagnostics).

[`chkit check`](/cli/check/) integration reports pending or failed backfills in CI.

## Plugin setup

In `clickhouse.config.ts`, register `backfill(...)` from `@chkit/plugin-backfill`.

```ts
import { defineConfig } from '@chkit/core'
import { backfill } from '@chkit/plugin-backfill'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  plugins: [
    backfill({
      stateDir: './chkit/backfill',
      defaults: {
        chunkHours: 6,
        maxParallelChunks: 1,
        maxRetriesPerChunk: 3,
        requireIdempotencyToken: true,
        timeColumn: 'created_at',
      },
      policy: {
        requireDryRunBeforeRun: true,
        requireExplicitWindow: true,
        blockOverlappingRuns: true,
        failCheckOnRequiredPendingBackfill: true,
      },
      limits: {
        maxWindowHours: 720,
        minChunkMinutes: 15,
      },
    }),
  ],
})
```

The `run` and `resume` commands execute SQL against ClickHouse when a connection is configured. Configure `clickhouse` at the top level of `clickhouse.config.ts`:

```ts
export default defineConfig({
  clickhouse: {
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: 'default',
    password: '',
    database: 'default',
  },
  schema: './src/db/schema/**/*.ts',
  plugins: [backfill(...)],
})
```

The URL and credentials can come from environment variables in CI environments.

## Backfill strategies

The plugin supports two strategies for backfilling data, chosen automatically based on your schema:

**Table backfill** (`table` strategy): For direct table targets, inserts data by selecting from the same table within the time window. This is the most common case.

**Materialized view replay** (`mv_replay` strategy): When the target is a materialized view's `to` table, the plugin detects the view's aggregation query and wraps it in a CTE (Common Table Expression). This re-materializes the aggregation for each chunk window, ensuring correctness for aggregate backfills. Requires `requireIdempotencyToken: true` for safe resumable retries.

## Time column resolution

The backfill plugin needs a time column to build WHERE clauses for each chunk. It resolves the column through a layered fallback chain:

1. **CLI flag** — `--time-column <column>` on the `plan` command.
2. **Schema-level config** — `plugins.backfill.timeColumn` on the table definition.
3. **Global default** — `defaults.timeColumn` in the plugin options.
4. **Auto-detection** — Scans ORDER BY columns and common time column names (`created_at`, `timestamp`, `event_time`, etc.) for DateTime/DateTime64 types.

Schema-level configuration is the recommended approach when different tables use different time columns. Define it directly in the `table()` call:

```ts
import { table } from '@chkit/core'

export const events = table({
  database: 'app',
  name: 'events',
  columns: [
    { name: 'event_time', type: 'DateTime' },
    { name: 'id', type: 'UInt64' },
  ],
  engine: 'MergeTree',
  orderBy: ['event_time', 'id'],
  primaryKey: ['event_time', 'id'],
  plugins: {
    backfill: { timeColumn: 'event_time' },
  },
})
```

This requires importing `@chkit/plugin-backfill` somewhere in the project (typically in `clickhouse.config.ts`) to activate the type augmentation. The `plugins.backfill` object is fully typed — autocomplete and type errors work as expected.

## Options

Configuration is organized into three groups plus a top-level `stateDir`.

**Top-level:**

- `stateDir` (default: `<metaDir>/backfill`) — Directory for plan, run, and event state files.

**`defaults` group:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `chunkHours` | `number` | `6` | Hours per chunk |
| `maxParallelChunks` | `number` | `1` | Max concurrent chunks |
| `maxRetriesPerChunk` | `number` | `3` | Retry budget per chunk |
| `requireIdempotencyToken` | `boolean` | `true` | Generate deterministic tokens |
| `timeColumn` | `string` | auto-detect | Fallback column name for time-based WHERE clause (overridden by schema-level config) |

**`policy` group:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `requireDryRunBeforeRun` | `boolean` | `true` | Require plan before run |
| `requireExplicitWindow` | `boolean` | `true` | Require `--from`/`--to` |
| `blockOverlappingRuns` | `boolean` | `true` | Prevent concurrent runs |
| `failCheckOnRequiredPendingBackfill` | `boolean` | `true` | Fail `chkit check` on incomplete backfills |

**`limits` group:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxWindowHours` | `number` | `720` (30 days) | Maximum window size |
| `minChunkMinutes` | `number` | `15` | Minimum chunk size |

Invalid option values fail fast at startup via plugin config validation.

## Commands

All commands exit with: 0 (success), 1 (runtime error), 2 (config error).

### `chkit plugin backfill plan`

Build a deterministic backfill plan and persist immutable plan state.

| Flag | Required | Description |
|------|----------|-------------|
| `--target <db.table>` | Yes | Target table in `database.table` format |
| `--from <timestamp>` | Yes | Window start (ISO timestamp) |
| `--to <timestamp>` | Yes | Window end (ISO timestamp) |
| `--chunk-hours <n>` | No | Override chunk size (defaults to `defaults.chunkHours`) |
| `--time-column <column>` | No | Time column for WHERE clause (auto-detected if omitted) |
| `--force-large-window` | No | Allow windows exceeding `limits.maxWindowHours` |
| `--force` | No | Delete existing plan and regenerate from scratch |

### `chkit plugin backfill run`

Execute a planned backfill with checkpointed chunk progress.

| Flag | Required | Description |
|------|----------|-------------|
| `--plan-id <hex16>` | Yes | Plan ID (16-char hex) |
| `--replay-done` | No | Re-execute already-completed chunks |
| `--replay-failed` | No | Re-execute failed chunks |
| `--force-overlap` | No | Allow concurrent runs for the same target |
| `--force-compatibility` | No | Skip compatibility token check |

### `chkit plugin backfill resume`

Resume a backfill run from last checkpoint. Same flags as `run` minus simulation flags.

### `chkit plugin backfill status`

Show checkpoint and chunk progress for a backfill run.

| Flag | Required | Description |
|------|----------|-------------|
| `--plan-id <hex16>` | Yes | Plan ID (16-char hex) |

### `chkit plugin backfill cancel`

Cancel an in-progress backfill run and prevent further chunk execution.

| Flag | Required | Description |
|------|----------|-------------|
| `--plan-id <hex16>` | Yes | Plan ID (16-char hex) |

### `chkit plugin backfill doctor`

Provide actionable remediation steps for failed or pending backfill runs.

| Flag | Required | Description |
|------|----------|-------------|
| `--plan-id <hex16>` | Yes | Plan ID (16-char hex) |

## CI / check integration

When configured, [`chkit check`](/cli/check/) includes a `plugins.backfill` block in JSON output and can fail with `plugin:backfill`.

Finding codes:

- `backfill_required_pending` — A plan has no run or the run is not completed.
- `backfill_chunk_failed_retry_exhausted` — A run has exhausted retries on a failed chunk.
- `backfill_policy_relaxed` — `failCheckOnRequiredPendingBackfill` is disabled (warning only).

When `failCheckOnRequiredPendingBackfill` is `true` (default), pending backfills cause [`chkit check`](/cli/check/) to fail with an error. When `false`, they emit a warning instead.

## State management

All state is persisted to the configured `stateDir`:

```
<stateDir>/
  plans/<planId>.json       # Immutable plan state (written once)
  runs/<planId>.json        # Mutable run checkpoint (updated per chunk)
  events/<planId>.ndjson    # Append-only event log
```

Plan IDs are deterministic: `sha256("<target>|<from>|<to>|<chunkHours>|<timeColumn>")` truncated to 16 hex characters. Re-planning with the same parameters produces the same plan ID.

## Common workflows

**Basic backfill:**

```sh
chkit plugin backfill plan --target analytics.events --from 2025-01-01 --to 2025-02-01
chkit plugin backfill run --plan-id <planId>
chkit plugin backfill status --plan-id <planId>
```

**Failed chunk recovery:**

```sh
chkit plugin backfill plan --target analytics.events --from 2025-01-01 --to 2025-02-01
chkit plugin backfill run --plan-id <planId>   # some chunks fail
chkit plugin backfill resume --plan-id <planId> --replay-failed
```

**CI enforcement:**

```sh
chkit check   # fails if pending backfills exist
```

## Current limits

- `maxParallelChunks` is declared but execution is currently sequential.
