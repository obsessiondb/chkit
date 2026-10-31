---
title: Loading and batching
description: Use the default loader, then tune batch sizes and concurrency when the workload needs it.
---

A loader writes the rows yielded by the reader, whether they contain raw objects or mapped columns.

## Start with the default loader

Omit `loader` from the stream definition, as in the [quickstart](/api-sync/quickstart/). chkit uses `simpleLoader()` to insert rows and attach ingestion metadata. Use this for both raw and shaped storage, including rows with embedded children.

`simpleLoader` is the only bundled loader. It makes direct, at-least-once inserts, adds ingestion metadata, and splits a load batch into deterministic write units with stable deduplication tokens. It does not stage data or replace a destination snapshot atomically.

Changing raw JSON to typed rows, changing a SQL view, using an SDK, or tuning concurrency does not require a custom loader.

## Tune insert size when needed

Start with the defaults. If measured request size or memory use requires smaller physical inserts, import `simpleLoader` from `@chkit/plugin-ingest` and set `loader: simpleLoader({ maxRowsPerInsert: 20_000 })` on the stream. This configures the same loader; it does not change mapping or checkpoint behavior. The size must be a positive integer; invalid sizes fail immediately.

Write-unit tokens include the batch identity and the row range. Keep the size unchanged while recovering an interrupted run for the best retry suppression. Changing it can reinsert overlapping ranges, but cannot suppress a larger range as though the smaller one had already saved every row.

## Size the three boundaries

| Boundary | Control | Default | Choose based on |
|---|---|---|---|
| Source page/chunk | Provider request parameters and reader yields | Provider-specific | API response limits and memory |
| Load batch | Stream `batchSize` | `10_000` rows | Insert overhead versus checkpoint latency |
| Physical insert | `simpleLoader({ maxRowsPerInsert })` | `50_000` rows | ClickHouse request size and per-row payload size |

`batchSize` is a flush threshold, not a hard slice size: a source chunk can push a batch above it. A chunk with an explicit `id` is kept as its own load batch. The loader may then split that batch into physical inserts. Use positive integer sizes; the per-insert size must be greater than zero.

The stream's `budget.maxChunkRows` (default `100_000`) rejects an oversized yielded chunk instead of silently splitting it. This does not prevent a reader from fetching an oversized response before it yields; bound source pages too.

## Concurrency and buffering

| Control | Scope | Default | Limits |
|---|---|---|---|
| `maxStreams` | Pipeline | `4` | Active stream executions |
| `maxFetches` | Pipeline | `4` | Source attempts running through `context.attempt` |
| `maxLoads` | Pipeline | `2` | Active load attempts |
| `prefetchBatches` | Plugin/runtime | `1` | Queued batches between fetching and loading for each active reader |

Separate pipelines have separate concurrency ceilings. If pipelines share a provider quota, account for the sum of their requests. These are concurrency limits, not rate limits measured in requests per second. Retry waits release fetch/load capacity for other work.

Increase buffering only when it helps overlap fetching and writing without excessive memory. Larger rows can make a modest row count expensive.

Content hashing and JSON conversion process one row at a time, and the native ClickHouse client streams the physical INSERT instead of building one batch-sized string. Rows are still buffered in memory; there is no byte quota or disk spool. Bound source pages and lower `batchSize` and `maxRowsPerInsert` for wide records. A single row must still fit the runtime's JSON/string limits.

## Batch identity

Without a chunk `id`, batch identity includes row content. This prefers a possible duplicate over suppressing data that changed between attempts. Adding a volatile field such as `synced_at: new Date()` changes identity on replay; use destination-owned ingestion time instead.

<details>
<summary>Use explicit chunk identity only for stable source intervals</summary>

Set `SourceChunk.id` only when it identifies a stable logical source interval whose replay is the same write. It is not a record primary key or a checkpoint. Explicit IDs make a chunk its own load batch and exclude row content from its identity; an offset into a changing dataset is not necessarily a stable interval.

Successful syncs rotate the identity cycle so subsequent updates can load. Failed/interrupted syncs retain their replay cycle. Deduplication still depends on the destination's engine, settings, and retention window; it is not an exactly-once guarantee.

On stock ClickHouse 26.3, `non_replicated_deduplication_window` defaults to `0` (off), while `replicated_deduplication_window` defaults to `10_000` blocks and `replicated_deduplication_window_seconds` to `3_600` seconds. Replays outside the retained window can insert duplicates, and replaying many old blocks can evict newer tokens before they are retried. These are version-specific server defaults, not settings chkit applies. Check the effective settings on replicated or managed/Shared engines rather than assuming the local defaults apply. `rawTable` reconciles records by ID with `FINAL`; a plain `MergeTree` does not. See [destination keys and versioning](/api-sync/destinations/).

</details>

## Custom loader contract

<details>
<summary>Extend publication only when direct inserts are insufficient</summary>

`LoaderFactory` is an extension interface for application code. There is no bundled snapshot-replacement or refreshing loader.

The executor constructs a loader for each batch attempt. Its context supplies `streamId`, `runId`, `table`, `destination`, and `signal`.

1. `write({ batchId, rows })` publishes the batch. Reuse deterministic tokens derived from `batchId`; do not base them on a new run ID or current time. Preserve the runtime metadata columns and cancellation semantics.
2. `finalize()` returns `{ evidence, rows, writeUnits }` only after publication has completed. Use `clickhouse_ack` for acknowledged writes, or `none_required` when no write was needed. The executor trusts this receipt before journaling progress.
3. `abort(reason)` releases resources after failure. Already acknowledged direct writes cannot be withdrawn; replay must remain safe.

Use `context.destination.insert({ table, rows, token })` for direct ClickHouse writes. If a loader uses another publication mechanism, it must still establish the required write evidence before returning success. Do not claim durability for queued, fire-and-forget, or staged data.

The stream's `retry` policy controls source attempts and reader recovery. Each load invocation has up to three attempts. Deterministic ClickHouse parse, type and column errors stop both load retries and reader recovery, with the original error preserved; `UNKNOWN_TABLE`, capacity, network and replica errors remain retryable. An exhausted retryable load error can still trigger reader recovery, which creates another load invocation, so the total insert attempts can exceed three.

The native destination waits for synchronous completion or, when async inserts are enabled on its client, an awaited async flush (`wait_for_async_insert=1`) before producing evidence. This is an insert acknowledgement, not a transaction spanning the destination and journal, a guarantee of replica quorum, or proof that subsequent queries have reconciled duplicate versions. Async retry suppression depends on the effective deduplication settings too: newer 26.3 patches use `deduplicate_insert`, while its compatibility mode consults `async_insert_deduplicate`.

</details>

## Related pages

- [Destinations and transformations](/api-sync/destinations/): map rows without replacing the loader.
- [Incremental syncs](/api-sync/incremental-syncs/): when committed writes advance progress.
- [Test a source](/api-sync/testing/): simulate a failed write and replay.
