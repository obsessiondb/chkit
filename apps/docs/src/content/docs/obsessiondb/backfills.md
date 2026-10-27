---
title: Backfill Jobs
description: Use the beta backfill plugin to submit managed ObsessionDB jobs and track their progress in the console.
sidebar:
  order: 5
---

The [backfill plugin (beta)](/plugins/backfill/) runs a backfill in one of two venues: locally against a direct ClickHouse connection, or as a **managed job** on ObsessionDB. This page covers the managed path — submitting a plan to the ObsessionDB job backend and tracking it from the console.

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

The console link from `submit` is the primary way to watch a job. It opens the job in the ObsessionDB console under Service → Jobs, with live progress and controls to pause, retry, or cancel the run. The [Jobs docs](https://obsessiondb.com/docs/jobs) cover that view in full. From the CLI, the remote job commands query the backend directly — they take a `--job-id` or `--service-slug` instead of a local `--plan-id`:

```sh
# All backfill jobs of the selected service
chkit plugin backfill list

# All backfill jobs of another service
chkit plugin backfill list --service-slug <service>

# Status of one job
chkit plugin backfill status --job-id <jobId>

# Cancel a running job
chkit plugin backfill cancel --job-id <jobId>
```

`list` lists the jobs of the service named by `--service-slug`, or of the selected service when the flag is left out; with neither it fails and asks for one. `status --service-slug <service>` prints the same list. Each job is one line with its ID, target table, state and task counts:

```
Backfill jobs for service <service> (2):
- 4f2c… analytics.events: running (3/12 completed, 1 failed)
- 9a1d… analytics.sessions: completed (8/8 completed, 0 failed)
```

`status --job-id` prints the job's state, task progress, the most recent task error (if any), and the console link:

```
Backfill job 4f2c… (analytics.events): running
Tasks: 3/12 completed, 1 failed
Last error: Memory limit (total) exceeded
Track progress: https://console.obsessiondb.com/<service>/jobs/4f2c…
```

The console link uses `--service-slug` when given, otherwise the selected service; without either it is left out. `cancel --job-id` prints `Cancellation requested for backfill job <jobId>.` followed by the same link.

With `--json`, each command returns one envelope. `status --job-id` carries the full job from the backend under `job`, with `lastError` and `url` alongside:

```json
{
  "command": "backfill status",
  "schemaVersion": 1,
  "ok": true,
  "job": { "id": "4f2c…", "target": "analytics.events", "status": "running", "totalTasks": 12, "completedTasks": 3, "failedTasks": 1, "tasks": [] },
  "lastError": "Memory limit (total) exceeded",
  "url": "https://console.obsessiondb.com/<service>/jobs/4f2c…"
}
```

`list` and `status --service-slug` return `serviceSlug`, `jobs` and `total`; `cancel` returns `jobId` and `url`. Failures, such as a missing session or an unknown job, return `{"command": "backfill status", "schemaVersion": 1, "ok": false, "error": {"code": "…", "message": "…"}}` and exit 1.

Passing `--plan-id` instead keeps `status`/`cancel` local, operating on on-disk run state rather than the backend. `list` has no local counterpart: without the ObsessionDB plugin, or with `--local`, it fails and explains how to set up a managed backend.

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

## Submitted jobs in `chkit check`

`submit` applies the [backfill plugin options](/plugins/backfill/#configuration-and-persisted-state) like `plan`, with flags overriding them. It saves its plan in the plugin's `stateDir` (default `<metaDir>/backfill/`) under `plans/`, and records the job ID in `submissions/<planId>.json` there. The job writes no local run checkpoint, so the backfill plugin's check leaves a submitted plan to the ObsessionDB plugin, whose check asks the jobs API for the job's status:

| Job status | Finding | Check |
| --- | --- | --- |
| `completed` | none; the confirmation is saved in the submission file | passes |
| `pending`, `running`, `draining`, `paused` | `obsessiondb_backfill_job_incomplete` | fails |
| `failed`, `cancelled` | `obsessiondb_backfill_job_failed`, with the last task error | fails |
| not logged in, session expired, API error | `obsessiondb_backfill_job_unverified` | fails |

Each finding names the plan and job IDs. Once a job is confirmed completed, later checks pass for that plan without contacting ObsessionDB. A project without submitted plans makes no API call.

```sh
chkit check --json
```

```json
"obsessiondb": {
  "evaluated": true,
  "ok": false,
  "findingCodes": ["obsessiondb_backfill_job_incomplete"],
  "backfillJobs": { "submitted": 1, "confirmed": 0, "incomplete": 1, "failed": 0, "unverified": 0 }
}
```

:::note
CI that runs `chkit check` needs an ObsessionDB session (`chkit obsessiondb login`) until every submitted job is confirmed completed. A confirmation is saved in `submissions/` in the backfill `stateDir`, so a CI runner that starts from the repository only skips the API call when that directory is committed.
:::

For a failed or cancelled job, inspect it with `chkit plugin backfill status --job-id <jobId>`. Then [re-submit the plan](#re-submit-a-failed-or-cancelled-job) with `--plan-id`, or run the plan locally with `--local`: once a local run exists, `check` judges the plan by that run instead.

## Re-submit a failed or cancelled job

`submit --plan-id` sends the chunks of a saved plan that never finished as a new job, and replaces the job ID in its submission file. The next `chkit check` follows the new job:

```sh
chkit plugin backfill status --job-id <jobId>
chkit plugin backfill submit --plan-id <planId>
```

```
Re-submitted backfill plan 3f9a… as job 7c1e… for analytics.events (9 tasks), replacing cancelled job 4f2c….
Skipped 3 chunks that already finished on the service.
Track progress: https://console.obsessiondb.com/<service>/jobs/7c1e…
```

The plan ID is in the `obsessiondb_backfill_job_failed` finding. `--title` and `--concurrency` apply to the new job; the planning flags (`--target`, `--cutover`, `--from`, `--to`, `--max-chunk-bytes`) are rejected with `--plan-id`, because the saved plan already fixes its chunks. The new job runs on the selected service.

### Chunks that already ran

A chunk the earlier job already wrote is left out of the new job. Writing it again would duplicate its rows whenever the second INSERT differs from the first, for example when a table is copied into itself and the chunk now also reads the rows it wrote; the idempotency token does not prevent that. The job's own task counts miss a chunk whose INSERT finished after the cancel, so `submit --plan-id` reads `system.processes` and `system.query_log` on every replica of the service instead, looking for the plan's chunk queries from any earlier job. A chunk whose `system.query_log` entry has already expired is submitted again.

### Refusals

`submit --plan-id` reads the current job's status first and only replaces a job that failed or was cancelled. Otherwise it starts no job, exits 1, and with `--json` returns `{"ok": false, "command": "backfill submit", "error": "…", "code": "…"}`:

| Code | Cause |
| --- | --- |
| `backfill_resubmit_job_active` | The job is `pending`, `running`, `draining` or `paused`. Cancel it with `cancel --job-id` or wait for it to finish. |
| `backfill_resubmit_job_completed` | The job already completed. |
| `backfill_resubmit_job_unverified` | The job status could not be read (session expired, API error). |
| `backfill_resubmit_chunks_running` | A chunk query of the plan still runs on the service. Retry once it finishes. |
| `backfill_resubmit_chunks_unverified` | `system.processes` or `system.query_log` could not be read. |
| `backfill_resubmit_nothing_to_run` | Every chunk already finished on the service. Check the target table; if the backfill is complete, delete `plans/<planId>.json` to clear the finding. |
| `backfill_resubmit_plan_not_found` | No saved plan has this ID. |
| `backfill_resubmit_not_submitted` | The plan has no submission file, so chkit cannot tell whether a job already runs it. |
| `backfill_resubmit_invalid_flags` | The plan ID is malformed, or planning flags were passed with `--plan-id`. |

On success the `--json` envelope adds `planId`, `replacedJobId` and `skippedChunks` to the usual `submit` fields.

## Related

- [Backfill Plugin (beta)](/plugins/backfill/) — full command reference, planning options, and local execution.
- [Services](/obsessiondb/services/) — select and override the ObsessionDB service jobs run against.
- [Overview](/obsessiondb/overview/) — install and register the ObsessionDB plugin.
