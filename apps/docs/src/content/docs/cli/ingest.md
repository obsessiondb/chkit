---
title: "chkit ingest"
description: "Run, list, or inspect the ingestion streams exported by your project entry."
sidebar:
  order: 11
---

Runs the TypeScript ingestion streams provided by [`@chkit/plugin-ingest`](/plugins/ingest/), lists them, or shows their committed checkpoints.

## Synopsis

```
chkit ingest run [flags]
chkit ingest list [flags]
chkit ingest status [flags]
```

`chkit ingest <subcommand>` is equivalent to `chkit plugin ingest <subcommand>`.

## Flags

### Selection (all subcommands)

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--tag <tag>` | string[] | — | Exact tag every selected stream must carry. Repeat for AND matching |

### `run` only

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--backfill <id>` | string | — | Stable backfill ID. Runs in an isolated checkpoint namespace |
| `--from <timestamp>` | string | — | Backfill range lower bound (ISO timestamp). Requires `--backfill` |
| `--to <timestamp>` | string | — | Backfill range upper bound (ISO timestamp). Requires `--backfill` |
| `--max-duration <seconds>` | string | `3600` | Execution budget. Overrides the plugin's `maxDurationSeconds` option |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

### Prerequisites

The ingest plugin must be registered in `plugins` and the config must set `entry` to a module that exports at least one `definePipeline(...)` value. Without an exported pipeline, every subcommand fails with exit code 2.

`run` and `status` require a direct `clickhouse` connection in the config. Host-provided executors, including the ObsessionDB workbench executor, are rejected. `list` reads only the definition graph and needs no connection.

### Stream selection

Without `--tag`, a subcommand selects every stream in the loaded graph. Each `--tag` narrows the selection: a stream is selected only when it carries every requested tag. Every stream carries its declared pipeline and stream tags plus the derived tags `pipeline:<id>` and `stream:<id>`.

A `--tag` filter that matches no stream fails with exit code 2 before any work runs.

### `run`

Executes the selected streams from their committed checkpoints and records progress in the ingestion journal (`_chkit_ingestion_journal` by default). Progress advances only after writes succeed; a later run resumes from the last committed checkpoint.

The run ends when every selected stream finishes, the execution budget is exhausted, or the process receives `SIGINT` or `SIGTERM`. A budget-exhausted or interrupted run keeps committed progress and exits with code 1. Each stream reports one outcome: `succeeded`, `failed`, `budget_exhausted`, or `cancelled`.

Run at most one ingestion process per project and target at a time. See [Scheduling and recovery](/ingestion/operations/).

### Backfills

`--backfill <id>` runs the selected streams under the checkpoint namespace `<stream id>#backfill:<id>`, so it never moves the scheduled checkpoint. Reusing an ID resumes that backfill's state. The ID must start with a letter or digit and contain only letters, digits, `_`, `.`, and `-`.

`--from` and `--to` set explicit bounds for `timestampWindow` streams and take precedence over the backfill's watermark. Full-sync and cursor strategies ignore them. Passing `--from` or `--to` without `--backfill` fails with exit code 2.

### `list`

Prints each selected stream with its destination table and effective tags.

### `status`

Reads the journal and prints the committed checkpoint of each selected stream's scheduled namespace. Streams that have never committed progress show `(no checkpoint)`.

## Examples

**Run everything on an hourly schedule:**

```sh
chkit ingest run --tag schedule:1h
```

**Run a single stream:**

```sh
chkit ingest run --tag stream:helpdesk.tickets
```

**Backfill January without moving the scheduled checkpoint:**

```sh
chkit ingest run --backfill jan --from 2026-01-01 --to 2026-02-01
```

**Cap a CI run at ten minutes:**

```sh
chkit ingest run --tag pipeline:helpdesk --max-duration 600
```

**Inspect progress as JSON:**

```sh
chkit ingest status --tag pipeline:helpdesk --json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success. For `run`, every selected stream succeeded |
| 1 | Error, or a `run` with any stream that did not succeed |
| 2 | Configuration error: no exported pipeline, no matching stream, invalid flags, or missing direct connection |

## JSON output

**`run`:**

```json
{
  "command": "run",
  "runId": "3f0c9a7e-2b1d-4c55-9e0a-6d8b1f2a4c11",
  "cutoff": "2026-09-24T10:00:00.000Z",
  "ok": true,
  "streams": [
    {
      "streamId": "helpdesk.tickets",
      "pipelineId": "helpdesk",
      "namespaceId": "helpdesk.tickets",
      "outcome": "succeeded",
      "rows": 1240,
      "batches": 3,
      "chunks": 13,
      "checkpointVersion": 42
    }
  ]
}
```

A failed stream sets `outcome` to `failed` and includes an `error` message; the top-level `ok` is then `false`.

**`list`:**

```json
{
  "ok": true,
  "command": "list",
  "streams": [
    {
      "streamId": "helpdesk.tickets",
      "pipelineId": "helpdesk",
      "destination": "crm.tickets",
      "strategy": "chkit.timestamp_window@1",
      "tags": ["schedule:1h", "pipeline:helpdesk", "stream:helpdesk.tickets"]
    }
  ]
}
```

**`status`:**

```json
{
  "ok": true,
  "command": "status",
  "targetId": "clickhouse.example.com:8443/crm",
  "streams": [
    {
      "streamId": "helpdesk.tickets",
      "pipelineId": "helpdesk",
      "destination": "crm.tickets",
      "strategy": "chkit.timestamp_window@1",
      "tags": ["schedule:1h", "pipeline:helpdesk", "stream:helpdesk.tickets"],
      "checkpointVersion": 42,
      "checkpoint": {
        "strategy": "chkit.timestamp_window",
        "version": 1,
        "state": { "watermark": "2026-09-24T09:00:00.000Z" }
      }
    }
  ]
}
```

**Error:**

```json
{
  "ok": false,
  "command": "run",
  "error": "No stream matches every requested tag: --tag schedule:15m. Nothing was executed."
}
```

## Related

- [Ingest plugin reference](/plugins/ingest/) — plugin setup, options, and stream definitions
- [Ingestion quickstart](/ingestion/quickstart/) — define a first stream and run it
- [Scheduling and recovery](/ingestion/operations/) — tags, retries, budgets, and backfills
- [`chkit check`](/cli/check/) — verifies that stream destinations carry the ingestion metadata columns
