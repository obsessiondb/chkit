---
title: Backfill Plugin
description: Plan, execute, and monitor time-windowed backfill operations with async query submission, concurrent execution, and checkpointed progress.
sidebar:
  order: 4
  badge:
    text: Alpha
    variant: caution
---

This document covers practical usage of the optional `backfill` plugin.

:::caution[Alpha]
The `backfill` plugin is in alpha. Its API, configuration, and CLI flags may change between releases.
:::

## What it does

- Builds deterministic, immutable backfill plans that divide a time window into chunks.
- Executes backfills via async query submission with configurable concurrency and server-side polling.
- Runs either locally against a direct ClickHouse connection or as a managed job on [ObsessionDB](/obsessiondb/backfills/) — the same plan, a different execution venue.
- Detects materialized views and automatically generates correct CTE-wrapped replay queries.
- Supports resume from checkpoint, cancel, status monitoring, and doctor-style diagnostics.
- Integrates with [`chkit check`](/cli/check/) for CI enforcement of pending backfills.
- Persists all state as JSON on disk.

## How it fits your workflow

The plugin follows a plan-then-execute lifecycle:

1. `plan` — Build an immutable backfill plan dividing the time window into chunks.
2. `run` — Submit chunks as async queries to ClickHouse with concurrent execution and progress polling.
3. `status` — Monitor chunk progress and run state.

Additional commands: `resume` (continue from checkpoint with optional failed-chunk replay), `cancel` (mark run as cancelled), `doctor` (actionable diagnostics).

To run the plan on a managed backend instead of your own machine, replace `run` with `submit` — see **Execution modes** below.

[`chkit check`](/cli/check/) integration reports pending or failed backfills in CI.

## Execution modes: local vs managed jobs

Backfills run in one of two venues. Both build the identical chunk plan with the same chunking algorithm — only where the chunks execute differs.

**Local execution** (`run`, `resume`) — Opens a direct ClickHouse connection and submits chunks as async queries from your machine, polling for completion. This is the default and requires a `clickhouse` block in your config. Plan and run checkpoint state live on disk under `stateDir`, so `resume`, `status`, `cancel`, and `doctor` operate on local files.

**Managed job** (`submit`) — Builds the same plan and hands the chunks to a managed job backend, which runs them server-side. Nothing streams from your machine and there is no local checkpoint to babysit — the command prints a job ID and a console link to track progress. Today the only managed backend is [ObsessionDB](/obsessiondb/backfills/); `submit` requires an authenticated session with a selected service.

When ObsessionDB is the active target (logged in with a service selected), `plan`, `run`, and `resume` are refused rather than silently opening a direct connection that bypasses ObsessionDB. Use `submit` to run the backfill as a managed job, or pass `--local` to force local execution against a direct ClickHouse connection. See [Backfill Jobs](/obsessiondb/backfills/) for the managed path in detail.

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
      chunkHours: 6,
      maxParallelChunks: 1,
      maxRetriesPerChunk: 3,
      requireIdempotencyToken: true,
      timeColumn: 'created_at',
      requireDryRunBeforeRun: true,
      requireExplicitWindow: true,
      blockOverlappingRuns: true,
      failCheckOnRequiredPendingBackfill: true,
      maxWindowHours: 720,
      minChunkMinutes: 15,
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

**Materialized view replay** (`mv_replay` strategy): When the target is the `to` table of one or more materialized views, the plugin replays each view's aggregation query over every chunk window, re-materializing the aggregation for that window and ensuring correctness for aggregate backfills. A target fed by several materialized views replays them all in a single `INSERT … SELECT … UNION ALL …` per chunk, so no view's rows are missed. Because the chunks are sized from the view's **source** table (the one it reads `FROM`) rather than the target, a from-scratch **empty** aggregate target is fine — it's the case being bootstrapped. Requires `requireIdempotencyToken: true` for safe resumable retries.

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

All options are passed as a flat object to `backfill({...})`. They are grouped here by function for readability.

- `stateDir` (default: `<metaDir>/backfill`) — Directory for plan and run state files.

**Planning defaults:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `chunkHours` | `number` | `6` | Hours per chunk |
| `maxChunkBytes` | `string \| number` | `10G` | Max bytes per chunk (accepts suffixes: `K`, `M`, `G`, `T`) |
| `maxParallelChunks` | `number` | `1` | Max concurrent chunks in plan |
| `maxRetriesPerChunk` | `number` | `3` | Retry budget per chunk |
| `retryDelayMs` | `number` | `1000` | Exponential backoff delay between retries (milliseconds) |
| `requireIdempotencyToken` | `boolean` | `true` | Generate deterministic tokens |
| `timeColumn` | `string` | auto-detect | Fallback column name for time-based WHERE clause (overridden by schema-level config) |

**Policy:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `requireDryRunBeforeRun` | `boolean` | `true` | Require plan before run |
| `requireExplicitWindow` | `boolean` | `true` | Require `--from`/`--to` |
| `blockOverlappingRuns` | `boolean` | `true` | Prevent concurrent runs |
| `failCheckOnRequiredPendingBackfill` | `boolean` | `true` | Fail `chkit check` on incomplete backfills |

**Limits:**

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

### `chkit plugin backfill submit`

Build the plan with the same chunking algorithm as `run`, then submit it to a managed job backend instead of executing it locally. Requires an authenticated [ObsessionDB](/obsessiondb/backfills/) session with a selected service (`chkit obsessiondb login`, then `chkit obsessiondb service select`); without one, the command explains how to set it up or fall back to `run --local`. On success it prints the job ID and a console link to track progress — the backend runs the chunks, so no local polling is needed. See [Backfill Jobs](/obsessiondb/backfills/) for the full managed flow.

| Flag | Required | Description |
|------|----------|-------------|
| `--target <db.table>` | Yes | Target table in `database.table` format |
| `--from <timestamp>` | No | Window start (ISO timestamp; defaults to the table's earliest partition) |
| `--to <timestamp>` | No | Window end (ISO timestamp; defaults to the table's latest partition) |
| `--max-chunk-bytes <size>` | No | Max bytes per chunk (e.g. `10G`, `500M`) |
| `--title <title>` | No | Human-readable job title shown in the console |
| `--concurrency <n>` | No | Max concurrent tasks the backend runs (1–48) |

### `chkit plugin backfill run`

Execute a planned backfill by submitting chunks as async queries to ClickHouse with concurrent execution and progress polling.

| Flag | Required | Description |
|------|----------|-------------|
| `--plan-id <hex16>` | Yes | Plan ID (16-char hex) |
| `--concurrency <n>` | No | Max concurrent async queries (default: `3`) |
| `--poll-interval <ms>` | No | Polling interval in milliseconds (default: `5000`) |
| `--force-environment` | No | Skip environment mismatch check (plan was created for a different ClickHouse cluster/database) |

### `chkit plugin backfill resume`

Resume a backfill run from last checkpoint. Picks up where the previous run left off, executing only pending chunks.

| Flag | Required | Description |
|------|----------|-------------|
| `--plan-id <hex16>` | Yes | Plan ID (16-char hex) |
| `--concurrency <n>` | No | Max concurrent async queries (default: `3`) |
| `--poll-interval <ms>` | No | Polling interval in milliseconds (default: `5000`) |
| `--replay-failed` | No | Reset failed chunks to pending and re-execute them |
| `--force-environment` | No | Skip environment mismatch check (plan was created for a different ClickHouse cluster/database) |

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
```

Plan IDs are deterministic: `sha256("<target>|<from>|<to>|<chunkHours>|<timeColumn>|<envFingerprint>")` truncated to 16 hex characters. When a ClickHouse connection is configured, an environment fingerprint is included in the plan ID, so different clusters/databases automatically produce different plan files. Re-planning with the same parameters produces the same plan ID.

### Environment binding

When `clickhouse` is configured in `clickhouse.config.ts`, backfill plans are **bound to the specific ClickHouse cluster and database** to prevent accidental cross-environment execution. The plan file stores:

- `environment.fingerprint` — A 16-char hash of the URL origin + database name
- `environment.url` — The cluster URL (for human readability)
- `environment.database` — The target database

When running or resuming a plan, chkit verifies the plan's environment matches the current config. If there's a mismatch (e.g., you created the plan against staging but switched to production), execution is blocked with a clear error message.

To override the check (e.g., intentionally backfilling production using a staging plan), use `--force-environment` on the `run` or `resume` command.

Plans created without a ClickHouse config (offline/dry-run) have no environment binding and can run against any environment.

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
chkit plugin backfill resume --plan-id <planId>   # automatically retries failed chunks
```

**Managed backfill on ObsessionDB:**

```sh
chkit obsessiondb login
chkit obsessiondb service select
chkit plugin backfill submit --target analytics.events --from 2025-01-01 --to 2025-02-01
# prints a job ID and a console link — the backend runs the chunks server-side
```

**CI enforcement:**

```sh
chkit check   # fails if pending backfills exist
```

