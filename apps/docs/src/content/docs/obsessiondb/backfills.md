---
title: Backfill Jobs
description: Run backfills as managed ObsessionDB jobs — submit a plan, track it in the console, and let the backend execute the chunks server-side.
sidebar:
  order: 5
---

The [backfill plugin](/plugins/backfill/) runs a backfill in one of two venues: locally against a direct ClickHouse connection, or as a **managed job** on ObsessionDB. This page covers the managed path — submitting a plan to the ObsessionDB job backend and tracking it from the console.

The chunking algorithm is identical either way. `submit` builds the exact same plan `run` would, then hands the chunks to the backend instead of streaming them from your machine.

## Prerequisites

Managed backfills need the ObsessionDB plugin registered (see the [Overview](/obsessiondb/overview/)), an authenticated session, and a selected service:

```sh
chkit obsessiondb login
chkit obsessiondb service select
```

The selection is persisted to `.chkit/obsessiondb.json` next to your config. Without a selected service there is nowhere to submit to, and `chkit plugin backfill submit` explains how to set one up (or fall back to local execution).

## Submit a backfill

`submit` plans and submits in one step — there is no separate `plan` command to run first:

```sh
chkit plugin backfill submit --target analytics.events --from 2025-01-01 --to 2025-02-01
```

On success it prints the job ID and a console deep-link:

```
Submitted backfill job 4f2c… for analytics.events (12 tasks).
Track progress: https://console.obsessiondb.com/<service>/jobs/4f2c…
```

The backend runs the chunks server-side, so there is no local checkpoint and nothing to poll from your machine. The window flags are optional — omit `--from`/`--to` to backfill from the table's earliest partition to its latest. See the [`submit` reference](/plugins/backfill/#chkit-plugin-backfill-submit) for the full flag table (`--title`, `--concurrency`, `--max-chunk-bytes`).

## Track progress

The console link from `submit` is the primary way to watch a job. From the CLI, the remote job commands query the backend directly — they take a `--job-id` or `--service-slug` instead of a local `--plan-id`:

```sh
# Status of one job
chkit plugin backfill status --job-id <jobId>

# All backfill jobs for a service
chkit plugin backfill status --service-slug <service>

# Cancel a running job
chkit plugin backfill cancel --job-id <jobId>
```

Passing `--plan-id` instead keeps `status`/`cancel` local, operating on on-disk run state rather than the backend.

## Local execution is guarded against ObsessionDB

`plan`, `run`, and `resume` execute the chunk loop against a direct ClickHouse connection. When ObsessionDB is the active target (logged in with a service selected, or `--service` set), these commands are **refused** rather than silently opening a connection that bypasses ObsessionDB:

```
Backfill run runs locally and is not supported directly against ObsessionDB.
Use `chkit backfill submit` to run it as a managed ObsessionDB job, or re-run with
--local to execute against a direct ClickHouse connection.
```

Two ways forward:

- **Run it as a managed job** — use `submit` (recommended for ObsessionDB targets).
- **Force local execution** — add `--local` to `plan`, `run`, or `resume` to skip remote routing and execute against a direct ClickHouse connection. This requires a `clickhouse` block in your config.

## How it works

Each chunk renders the same idempotent `INSERT … SELECT` the local executor would run, including CTE-wrapped materialized-view replay when the target is an MV's `to` table. The backend receives the task list, executes chunks with the requested `--concurrency` (1–48), and retries failed chunks up to the plan's per-chunk retry budget. Idempotency tokens make re-runs safe: re-submitting the same window does not double-write.

## Related

- [Backfill Plugin](/plugins/backfill/) — full command reference, planning options, and local execution.
- [Services](/obsessiondb/services/) — select and override the ObsessionDB service jobs run against.
- [Overview](/obsessiondb/overview/) — install and register the ObsessionDB plugin.
