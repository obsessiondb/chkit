---
title: Scheduling and recovery
description: Select streams, configure retries and limits, backfill source data, and inspect ingestion progress.
---

Run ingestion as a finite process and use an external scheduler to control cadence and prevent overlapping executions.

## Execute a run

Start by running the source once with the CLI:

```sh
chkit ingest run --tag stream:helpdesk.tickets
```

The CLI uses the configured ClickHouse journal and destination. Check the result, then schedule the command with cron, CI, or a job runner.

## Schedule and select streams

| Selection | Command |
|---|---|
| Entire loaded graph | `chkit ingest run` |
| Pipeline | `chkit ingest run --tag pipeline:helpdesk` |
| Stream | `chkit ingest run --tag stream:helpdesk.tickets` |
| Shared cadence | `chkit ingest run --tag schedule:1h` |
| Intersection of tags | `chkit ingest run --tag schedule:1h --tag account:42` |

Tags are exact and case-sensitive. Effective tags combine pipeline tags, stream tags, and derived `pipeline:<id>` / `stream:<id>` tags. Repeated `--tag` uses AND semantics; an explicit filter matching nothing fails before execution.

`schedule:1h` is only a naming convention. Choose cron for a simple host, CI for an existing automation environment, or a job scheduler for managed execution. None of these is built into chkit.

Run at most one ingestion process per project and target at a time, including historical runs. Configure concurrency control across all schedules and tag selections; pipeline limits do not lock out another process. Within a run, independent streams can run concurrently and a normal failure in one does not prevent the others from being attempted.

## Retries and provider errors

Start with built-in HTTP/network classification. Throw `HttpError.fromResponse(response)` for unsuccessful HTTP responses. The default classification treats 429 as rate limiting, 408/425/5xx as transient, and other 4xx as permanent. `Retry-After` is respected for rate-limited failures.

Set `retry` on a pipeline for shared defaults, then override individual fields on a stream. Use stream `classifyError(cause, fallback)` for SDK error types or provider-specific semantics; returning `undefined` keeps the fallback. Classification values are `cancelled`, `rate_limited`, `transient`, `permanent`, and `unknown`.

<details>
<summary>Retry defaults and advanced callbacks</summary>

| Retry option | Default | Purpose |
|---|---|---|
| `retries` | `5` | Retries after the initial source attempt |
| `factor` | `2` | Exponential backoff factor |
| `minTimeout` | `1000` ms | Initial backoff |
| `maxTimeout` | `60_000` ms | Backoff cap |
| `randomize` | `true` | Add jitter |
| `maxRetryTime` | `600_000` ms | Retry time budget |
| `shouldRetry` | No custom callback | Decide whether a retryable failure should retry |
| `shouldConsumeRetry` | No custom callback | Decide whether a failure consumes the retry count |

Callbacks receive `attemptNumber`, `retriesLeft`, `retriesConsumed`, and a `FetchFailure` with its original `cause` and normalized `classification`. Returning false from `shouldConsumeRetry` skips consumption and exponential backoff; provider `Retry-After` still applies. Permanent failures and cancellation stop before policy callbacks can turn them into retries.

An exhausted request retry budget fails the stream; reader recovery does not multiply that budget. Other reader failures can restart from the last committed state. Insert retries are separate from this source retry policy.

</details>

## Execution budgets

| Control | Default | Behavior |
|---|---|---|
| `ingest({ maxDurationSeconds })` | `3600` seconds | Bounds execution, including journal operations |
| `--max-duration <seconds>` | Plugin value | Overrides duration for one run |
| Stream `budget.maxChunks` | Unlimited | Stops after a source chunk budget; the run is incomplete |
| Stream `budget.maxChunkRows` | `100_000` | Fails a stream that yields a larger chunk |
| `ingest({ journalTable })` | `_chkit_ingestion_journal` | Journal table in the configured database |

A run that exhausts its budget retains committed progress and ends as incomplete. The CLI returns `1` for an incomplete execution; `0` means every selected stream succeeded. Cancellation also retains committed progress. Shutdown and terminal journal writes have bounded grace periods, so shutdown can extend past the main duration budget.

Treat the journal as durable operational state. Changing its name or the configured target identity starts a different checkpoint history. Do not use a journal-table change as routine retry handling.

## Backfill source data

Use the timestamp strategy (or a custom range-aware strategy) to read an explicit historical interval:

```sh
chkit ingest run --tag stream:helpdesk.tickets \
  --backfill tickets-jan-2026 \
  --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z
```

`--from` and `--to` require `--backfill`. The ID creates an isolated checkpoint namespace, preserving the ordinary scheduled bookmark. Reusing an ID reuses that namespace; actual resumption depends on the strategy. With explicit timestamp bounds, the same bounds take precedence over a stored watermark, so rerunning that command rereads the range. A checkpointed custom strategy can resume within it.

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
| No checkpoint after a successful run | Full syncs have no incremental bookmark |
| Window restarts from the beginning | Timestamp progress commits after the whole window; reduce work or use safe intermediate provider state |
| Duplicated logical records | Destination keys/versioning, query reconciliation, deduplication settings, and volatile mapped fields |
| Incompatible checkpoint | Strategy ID/version or state format changed |
| Direct connection required | Configure `clickhouse`; workbench authentication alone is insufficient |
| Authentication failure | Correct provider credentials/scopes before rerunning |

Retry with `ingest run` after fixing the error; the journal supplies committed state. Keep the stream ID to preserve its checkpoint history. Changing the ID starts a new history.

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
