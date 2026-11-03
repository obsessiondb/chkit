---
title: Scheduling and recovery
description: Schedule chkit Sync (beta), select streams, configure retries, and recover overlapping or interrupted runs.
---

Run ingestion as a finite process, use an external scheduler for cadence, and resume from validated ClickHouse journal evidence.

## Execute a run

Start by running the source once with the CLI:

```sh
chkit ingest run --tag stream:helpdesk.tickets
```

Apply destination schema migrations first. The CLI uses the configured ClickHouse journal and destination. Check the result, then schedule the command with cron, CI, or a job runner.

## Schedule and select streams

| Selection | Command |
|---|---|
| Entire loaded graph | `chkit ingest run` |
| Pipeline | `chkit ingest run --tag pipeline:helpdesk` |
| Stream | `chkit ingest run --tag stream:helpdesk.tickets` |
| Shared cadence | `chkit ingest run --tag schedule:1h` |
| Intersection of tags | `chkit ingest run --tag schedule:1h --tag account:42` |

Tags are exact and case-sensitive. Effective tags combine pipeline tags, stream tags, and derived `pipeline:<id>` / `stream:<id>` tags; declared tags cannot start with those two prefixes. Repeated `--tag` uses AND semantics; an explicit filter matching nothing fails before execution.

`schedule:1h` is only a naming convention. Choose cron for a simple host, CI for an existing automation environment, or a job scheduler for managed execution. None of these is built into chkit.

Overlapping executions of a stream are supported. Independent streams can run concurrently within one run, and a normal failure in one does not prevent the others from being attempted. Scheduler concurrency limits control resource use and provider request volume.

## Overlapping runs and checkpoint recovery

The append-only ClickHouse journal stores each run's starting checkpoint and a local event sequence. Event identity includes the run, so two processes that read the same checkpoint write independent histories. Progress is recorded only after destination acknowledgement. A lost acknowledgement retries the same facts; interruption leaves previously acknowledged progress available.

Before resuming, ChKit reads the complete namespace in one SELECT snapshot and validates each run's facts, checkpoint transitions, and starting checkpoint. Valid histories are selected deterministically; malformed tails are diagnosed and excluded from progress. Older legacy journal rows remain readable. Overlapping valid runs require no journal repair.

`timestampWindow` resumes from the greatest validated watermark. Custom cursor state remains opaque: recorded checkpoint ancestry and deterministic run ordering select one valid state. A selected cursor does not merge progress from concurrent branches, so already acknowledged work from another branch may be replayed.

Journal reads disable the query cache and request `select_sequential_consistency = 1`. An older valid snapshot can cause work to be replayed. Run-scoped identities keep that replay independent of another process's journal facts. Destination delivery remains at-least-once; choose keys and versioning that reconcile repeats.

On self-managed ClickHouse, automatic journal creation uses a local `MergeTree` table; `clickhouse.cluster` does not make that journal replicated. Before routing ingestion between nodes, provision a shared replicated journal with the matching schema and verify its visibility and engine on every serving node. Finish cluster DDL before starting ingestion: an overlapping `ensure()` can create a local table first, causing `CREATE TABLE IF NOT EXISTS ... ON CLUSTER` to leave it unreplicated. The read setting alone does not guarantee that every replica has received every write.

Retain the complete active journal, not just recent partitions. Checkpoint ancestry can refer to older months; a TTL or partition deletion can make later checkpoints unverifiable and reset the selected progress to the beginning. Repair cannot reconstruct deleted evidence. Restore the missing history or plan an intentional re-sync rather than pruning the active journal as ordinary telemetry.

## Retries and provider errors

Retries need no configuration. `context.fetch` throws `HttpError` for unsuccessful responses; requests made another way throw `HttpError.fromResponse(response)` themselves. The classification treats 429 as rate limiting, 408/425/5xx as transient, and other 4xx as permanent.

Requests of one pipeline share a request queue across its streams. `maxFetches` limits how many run at once, and a rate-limited response with `Retry-After` pauses the whole queue until then, so other streams of the pipeline do not run into the same limit. A rate-limit retry that the provider schedules at least the initial backoff ahead does not count against the retry limit; the retry time budget and the execution budget still bound it. Templates therefore send requests without fixed pauses.

A provider client maps what the classification cannot see: a rate limit reported as 403 or inside a successful response, or a wait given in a provider-specific reset header. Throw `HttpError.withStatus(response, 429, { retryAfterMs })` for it, inside the request's attempt: a `paginate` page, or `context.attempt` around the request. The original URL and headers, including `Retry-After`, are kept, and `Retry-After` wins over `retryAfterMs`.

```ts
const get = (url: string) => context.attempt(
  () => context.fetch(url, { headers }).catch((error: unknown) => {
    throw error instanceof HttpError && error.status === 403 && error.body.includes('rateLimitExceeded')
      ? HttpError.withStatus(error.response, 429, { body: error.body })
      : error
  }),
  { label: `GET ${new URL(url).pathname}` },
)
```

### Retry boundaries

Only transient failures are retried: network error codes, including those in an error's `cause` chain, timeouts, and `HttpError` 408/425/429/5xx. Any other failure fails the stream once, wherever it is thrown: a malformed payload, a `ZodError`, a missing credential, an invalid checkpoint, or a bug. No special error type is needed.

Only requests are retried:

| Where | Retried |
|---|---|
| `context.fetch`, `context.attempt`, and each `paginate` page | That request, up to 5 times with exponential backoff |
| Destination inserts | A fixed budget of 3 attempts |
| Journal writes | A fixed budget of 4 attempts |

A failure anywhere else in the reader, its strategy, or checkpoint parsing fails the stream, transient or not; the next run resumes from the last committed state. A request that exhausts its retries fails the stream the same way. `context.fetch` and `context.attempt` reject with exactly the thrown value, so a reader can handle its own errors. A `context.fetch` or `context.attempt` inside a `paginate` page shares that page's attempt instead of starting another.

<details>
<summary>Request retry settings</summary>

| Setting | Value | Purpose |
|---|---|---|
| `retries` | `5` | Retries after the initial request |
| `minTimeout` | `1000` ms | Initial backoff, doubled per retry |
| `maxTimeout` | `60_000` ms | Backoff cap |
| `randomize` | `true` | Add jitter |
| `maxRetryTime` | `600_000` ms | Retry time budget |

`chkit ingest run` uses these values. A host that embeds `runIngestion` can pass `retry` with any of these fields, for example `{ retries: 0 }` in a test. Insert and journal writes keep their fixed budgets.

</details>

## Execution budgets

| Control | Default | Behavior |
|---|---|---|
| `ingest({ maxDurationSeconds })` | `3600` seconds | Bounds execution, including journal operations; at most `2147483` seconds |
| `--max-duration <seconds>` | Plugin value | Overrides duration for one run |
| Stream `budget.maxChunks` | Unlimited | Stops after a source chunk budget; the run is incomplete |
| Stream `budget.maxChunkRows` | `100_000` | Fails a stream that yields a larger chunk |
| `ingest({ journalTable })` | `_chkit_ingestion_journal` | Journal table in the configured database |

A run that exhausts its budget retains committed progress and ends as incomplete. The CLI returns `1` for an incomplete execution; `0` means every selected stream succeeded. A configuration error exits `2` before any stream runs, for example an invalid pipeline definition, a definition module that fails to load, a `--tag` that matches no stream, a missing ClickHouse connection, `--from`/`--to` without `--backfill`, or an invalid backfill id or `--max-duration` value. See [`chkit ingest` exit codes](/cli/ingest/#exit-codes). Cancellation also retains committed progress. Shutdown and terminal journal writes have bounded grace periods, so shutdown can extend past the main duration budget.

Treat the journal as durable operational state. Changing the journal name or configured target identity starts a different checkpoint history. Do not change them as routine retry handling.

## Backfill source data

Use the timestamp strategy (or a custom range-aware strategy) to read an explicit historical interval:

```sh
chkit ingest run --tag stream:helpdesk.tickets \
  --backfill tickets-jan-2026 \
  --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z
```

`--from` and `--to` require `--backfill`. Range validation belongs to the strategy: `timestampWindow` rejects reversed bounds but accepts equal bounds as an empty window; `fullSync` and `cursorState` ignore them. The ID creates an isolated checkpoint namespace, preserving the ordinary scheduled bookmark. Reusing an ID reuses that namespace; actual resumption depends on the strategy. With explicit timestamp bounds, the same bounds take precedence over a stored watermark, so rerunning that command rereads the range. A checkpointed custom strategy can resume within it.

Isolation applies to checkpoints, not the destination table. Historical rows still use the stream's configured destination and version semantics. With `rawTable`, later ingestion time wins, so older source versions loaded later can replace newer objects. Use source-versioned destinations when that ordering matters.

For data already in ClickHouse that needs transformation or materialized-view replay, use the separate [backfill plugin](/plugins/backfill/). It has a different plan/run lifecycle and state model.

## Inspect progress and recover

```sh
chkit ingest list --tag pipeline:helpdesk --json
chkit ingest run --tag pipeline:helpdesk --json
chkit ingest status --tag pipeline:helpdesk --json
```

`list` inspects exported streams. `status` shows ordinary stream checkpoints; it is not a history of run outcomes and has no `--backfill` selection flag. Use run JSON and the journal for historical namespaces and failures. Run JSON includes each stream's `outcome`, row/batch/chunk counts, checkpoint version, and any error. The runtime emits OpenTelemetry execution, stream, and load spans. Configure a tracer provider/exporter in the host to collect them.

| Symptom | Check |
|---|---|
| No pipeline / no matching streams | Entry exports and exact tag spelling |
| No checkpoint after a successful run | The bundled `fullSync()` strategy has no checkpoint; custom full-scan strategies may record completion |
| Window restarts from the beginning | Timestamp progress commits after the whole window; reduce work or use safe intermediate provider state |
| Timestamp window never completes under `budget.maxChunks` | A window that needs at least as many chunks as the budget ends as `budget_exhausted` before completion is claimed, so the watermark never advances. Raise `maxChunks`, shrink the window, or use provider state |
| `planned lower bound … is after upper bound` | The effective lower bound exceeds the cutoff or explicit upper bound. Check host clock skew, a future `start`, overlap, custom `from`, and backfill bounds. Committed progress is unchanged; planning can succeed once the upper bound reaches the effective lower bound |
| Duplicated logical records | Destination keys/versioning, query reconciliation, deduplication settings, and volatile mapped fields |
| Incompatible checkpoint | Strategy ID/version or state format changed |
| Direct connection required | Configure `clickhouse`; workbench authentication alone is insufficient |
| Authentication failure | Correct provider credentials/scopes before rerunning |
| Overlapping runs use more requests than expected | Adjust scheduler concurrency or provider request limits |
| Journal source table is missing | Restore its evidence before repair; changing table names does not restore history |
| Doctor reports a malformed run tail | Review the retained checkpoint and repair plan; valid acknowledged progress remains resumable |

Retry with `ingest run` after fixing the error; the validated journal supplies committed state. Keep the stream ID to preserve its checkpoint history. Changing the ID starts a new history.

### Review and materialize journal recovery

1. Diagnose the selected namespace without changing data:

   ```sh
   chkit ingest doctor --tag stream:helpdesk.tickets --json
   ```

2. If recovery is needed, stop every writer using the journal table. Review the retained checkpoint, evidence counts, activation instructions, and fingerprint:

   ```sh
   chkit ingest repair --tag stream:helpdesk.tickets --json
   ```

3. Materialize the exact reviewed snapshot:

   ```sh
   chkit ingest repair --tag stream:helpdesk.tickets --apply <fingerprint>
   ```

4. Keep writers stopped. Set `ingest({ journalTable: '<replacementTable>' })` in the project config to the replacement table returned by the command, then restart ingestion.

Add `--backfill <id>` to both diagnostic and repair commands for an isolated historical namespace. Applying recovery requires exactly one selected stream. Any source-table change invalidates the fingerprint and requires a new review.

Repair verifies a full archive of the original table and a separate replacement containing the selected namespace's valid facts. Other targets and namespaces are copied unchanged. The original journal remains intact. Activation is a manual configuration change; writers must remain stopped until that change is complete. Uncertain destination writes may be loaded again. Missing source evidence requires restoration before repair.

## More execution patterns

<details>
<summary>Sequence dependent stages or embed the runtime</summary>

For dependent stages, such as raw ingestion followed by a derived-document stream, invoke the stages sequentially and check the first exit code before starting the second. An unfiltered run may execute both at once; exported pipelines do not form a dependency graph.

Use programmatic `runIngestion` when embedding execution in an existing service or supplying runtime adapters. The host then owns configuration, cancellation, and outcome handling. See [Testing](/api-sync/testing/) for a complete runtime example.

</details>

## Related pages

- [Incremental syncs](/api-sync/incremental-syncs/): strategy-dependent resumption.
- [Loading and batching](/api-sync/loading/): concurrency, buffers, and write identity.
- [Test a source](/api-sync/testing/): verify recovery before scheduling it.
