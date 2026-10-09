---
title: "chkit ingest"
description: "Run, inspect, diagnose, or repair the ingestion streams your project exports."
sidebar:
  order: 11
---

Runs the TypeScript ingestion streams provided by [`@chkit/plugin-ingest`](/plugins/ingest/) and inspects or repairs their ClickHouse journal history.

## Synopsis

```sh
chkit ingest run [flags]
chkit ingest list [flags]
chkit ingest status [flags]
chkit ingest doctor [flags]
chkit ingest repair [flags]
```

`chkit ingest <subcommand>` is equivalent to `chkit plugin ingest <subcommand>`.

## Flags

### Selection (all subcommands)

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--tag <tag>` | string[] | — | Exact tag every selected stream must carry. Repeat for AND matching |

### Namespace selection (`run`, `doctor`, and `repair`)

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--backfill <id>` | string | — | Select the isolated `<stream id>#backfill:<id>` checkpoint namespace |

### `run` only

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--from <timestamp>` | string | — | Backfill range lower bound (ISO timestamp). Requires `--backfill` |
| `--to <timestamp>` | string | — | Backfill range upper bound (ISO timestamp). Requires `--backfill` |
| `--max-duration <seconds>` | string | `3600` | Execution budget. Overrides the plugin's `maxDurationSeconds` option |

### `repair` only

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--apply <fingerprint>` | string | — | Materialize the exact reviewed plan. Stop writers first; requires exactly one selected stream |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

### Prerequisites

The ingest plugin must be registered in `plugins`, and the modules loaded from `entry` (or from `schema` globs) must export at least one `definePipeline(...)` value. Without an exported pipeline, every subcommand fails with exit code 2.

`run`, `status`, `doctor`, and `repair` require a direct `clickhouse` connection in the config. Host-provided executors, including the ObsessionDB workbench executor, are rejected. `list` reads only the definition graph and needs no connection.

Create and apply destination schema migrations before ingestion. The journal uses ordinary ClickHouse CREATE, SELECT, and INSERT operations. Overlapping runs record independent histories, and valid legacy journal evidence remains readable.

### Stream selection

Without `--tag`, a subcommand selects every stream in the loaded graph. Each `--tag` narrows the selection: a stream is selected only when it carries every requested tag. Every stream carries its declared pipeline and stream tags plus the derived tags `pipeline:<id>` and `stream:<id>`.

A `--tag` filter that matches no stream fails with exit code 2 before any work runs.

### `run`

Executes the selected streams from validated checkpoints in the ingestion journal (`_chkit_ingestion_journal` by default). Each run records its starting checkpoint and local event sequence. Progress advances after writes succeed; a later run resumes from a selected valid checkpoint.

The run ends when every selected stream finishes, the execution budget is exhausted, or the process receives `SIGINT` or `SIGTERM`. A budget-exhausted or interrupted run keeps committed progress and exits with code 1. Each stream reports one outcome: `succeeded`, `failed`, `budget_exhausted`, or `cancelled`.

Overlapping processes write independent run-scoped identities. A stale valid read can replay work without colliding with another run's event sequence. Snapshot validation diagnoses malformed tails and retains valid acknowledged progress. Destination delivery remains at-least-once. See [Scheduling and recovery](/api-sync/operations/).

### Backfills

`--backfill <id>` runs the selected streams under the checkpoint namespace `<stream id>#backfill:<id>`, so it never moves the scheduled checkpoint. Reusing an ID resumes that backfill's state. The ID must start with a letter or digit and contain only letters, digits, `_`, `.`, and `-`.

`--from` and `--to` set explicit bounds for `timestampWindow` streams and take precedence over the backfill's watermark. The bundled `fullSync()` and `cursorState()` strategies do not interpret them. Custom provider strategies may honor or reject date bounds; see the source's documentation. Passing `--from` or `--to` without `--backfill` fails with exit code 2.

### `list`

Prints each selected stream with its destination table and effective tags.

### `status`

Prints the committed checkpoint of each selected stream's scheduled namespace. Streams that have never committed progress show `(no checkpoint)`.

`status` ensures the journal table exists before reading, so the connection needs CREATE permission. Its checkpoint read validates the complete namespace snapshot and selects valid progress.

### `doctor`

Reads one complete source-table snapshot and validates the selected namespace's run histories. Reports the selected checkpoint, run count, evidence counts, and malformed tails. Valid overlapping runs are healthy. It does not create or mutate tables, fetch source data, or change destination rows.

### `repair`

Without `--apply`, prints a read-only recovery plan with its fingerprint, selected valid checkpoint, evidence counts, and activation instructions. Materializing a plan requires exactly one selected stream and the fingerprint from its preview. Stop all writers using the journal table before previewing and applying recovery. Any source-table change invalidates the fingerprint and requires a new review.

Applied repair verifies a full archive and a separate replacement journal. The replacement retains the selected namespace's valid facts and copies other targets and namespaces unchanged. The original journal remains intact. A failed verification leaves the active configuration unchanged. Missing source evidence requires restoration before repair.

Keep writers stopped after materialization. Configure `ingest({ journalTable: '<replacementTable>' })` with the returned table, then restart them. `--apply` creates the reviewed artifacts; activation remains this explicit configuration change. Uncertain destination writes may be replayed and duplicated.

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

**Inspect progress or diagnose a backfill:**

```sh
chkit ingest status --tag pipeline:helpdesk --json
chkit ingest doctor --tag stream:helpdesk.tickets --backfill jan --json
```

**Preview and materialize reviewed recovery:**

```sh
chkit ingest repair --tag stream:helpdesk.tickets --json
# Stop all journal writers, review the output, and use the printed fingerprint.
chkit ingest repair --tag stream:helpdesk.tickets --apply <fingerprint>
# Keep writers stopped; configure ingest({ journalTable: '<replacementTable>' }).
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success. For `run`, every selected stream succeeded; for `doctor`, every history is healthy; a repair preview completed or the reviewed replacement was materialized |
| 1 | Error, including an unknown flag or missing flag value, an unhealthy `doctor` report, or a `run` with any stream that did not succeed |
| 2 | Configuration error: no exported pipeline, no matching stream, an invalid `--backfill`, `--from`, `--to`, or `--max-duration` value, `--from`/`--to` without `--backfill`, or missing direct connection |

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

**`repair` preview:**

```json
{
  "ok": true,
  "command": "repair",
  "targetId": "clickhouse.example.com:8443/crm",
  "streams": [
    {
      "streamId": "helpdesk.tickets",
      "pipelineId": "helpdesk",
      "destination": "crm.tickets",
      "strategy": "chkit.timestamp_window@1",
      "tags": ["schedule:1h", "pipeline:helpdesk", "stream:helpdesk.tickets"],
      "applied": false,
      "activated": false,
      "plan": {
        "namespaceId": "helpdesk.tickets",
        "sourceTable": "_chkit_ingestion_journal",
        "fingerprint": "19e549d09d1d64d8c899b998fbf50e8b984046e0757b3452d4fd98a9b8f36ba7",
        "healthy": false,
        "repairable": true,
        "problems": ["Malformed trailing evidence in run sync-42"],
        "evidenceRows": 12,
        "selectedEvidenceRows": 8,
        "retainedFacts": 10,
        "runs": 2,
        "checkpoint": {
          "version": 1,
          "headSeq": 4,
          "lastSuccessSeq": 4,
          "checkpointId": "sync-41:3",
          "successId": "sync-41:4",
          "envelope": {
            "strategy": "chkit.timestamp_window",
            "version": 1,
            "state": { "watermark": "2026-09-24T09:00:00.000Z" }
          }
        },
        "archiveTable": "_chkit_ingestion_journal_archive_19e549d09d1d64d8c899b998",
        "replacementTable": "_chkit_ingestion_journal_repair_19e549d09d1d64d8c899b998",
        "activation": "Stop all ingestion writers, materialize the reviewed repair, then configure the returned journal table before restarting them.",
        "replayWarning": "The next run resumes from the selected valid checkpoint. Uncertain destination writes may be loaded again (at least once)."
      }
    }
  ]
}
```

Materialized output sets `applied` to `true`, keeps `activated` at `false`, and adds a unique copy ID to the archive and replacement names. Its `activation` field names the exact `journalTable` configuration to adopt. `doctor` uses the same plan fields under each stream's `report`; its top-level `ok` is `false` when any selected history has diagnostic problems.

## Related commands

- [Ingest plugin reference](/plugins/ingest/) — plugin setup, options, and stream definitions
- [API sync quickstart](/api-sync/quickstart/) — define a first stream and run it
- [Scheduling and recovery](/api-sync/operations/) — tags, retries, budgets, and backfills
- [`chkit check`](/cli/check/) — verifies that stream destinations carry the ingestion metadata columns
