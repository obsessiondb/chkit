---
title: Loading and batching
description: Choose direct inserts or opt-in staged deduplication, with explicit identity, concurrency and recovery limits.
---

A loader writes the rows yielded by the reader, whether they contain raw objects or mapped columns.

## Start with the default loader

- Omit `loader`, as in the [quickstart](/api-sync/quickstart/), for `simpleLoader()`: cheap, direct, at-least-once inserts with ingestion metadata.
- Each physical write unit gets a stable retry token. Native deduplication depends on engine settings and finite token retention, not logical row keys; keep insert sizing stable across retries.
- Use it for raw or shaped rows when duplicates are acceptable or reconciled downstream. Mapping, embedded children, SDKs and concurrency tuning do not require another loader.

## Opt into staged deduplication

- Choose `stagedLoader` for immutable observations with stable keys, overlapping reads or retries beyond native token retention. Deduplication is opt-in, not required by the engine.
- It stages a logical batch, selects one whole-row winner per key, then publishes only keys absent from the destination. Progress follows publication, never staging.
- Do not use insert-if-absent for mutable current state or deletions; choose a replacing-table/read model or another update strategy. Neither bundled loader atomically replaces a snapshot.

### Identity and winners

| Identity | Example | Meaning |
|---|---|---|
| Entity | `['account_id', 'id']` | Keep the first published entity; later changed payloads are filtered out. |
| Version/content | `['account_id', 'id', 'version']` | Retain each distinct observation; a stable content hash can replace a source version. |
| Transport | `SourceChunk.id`, batch ID, physical query ID | Identify replay or one SQL operation, not logical record equality. |

- `winner: 'first' | 'last'` chooses one **whole row by input position within the logical batch**, across physical inserts—not the globally newest timestamp. Keep replay order stable, or sort bounded source units.
- Existing destination keys always win, even when payloads differ. Existing duplicates remain; TTL or deletion makes removed keys eligible again.
- Keys must be nonempty, distinct, writable, non-null scalar columns, explicitly supplied in every row. Defaults cannot invent identity; null payload fields are allowed independently.
- Supported types: `String`, `FixedString`, integers, `UUID`, `IPv4`/`IPv6`, `Date`/`Date32`, `DateTime`/`DateTime64`, and compatible `LowCardinality` wrappers. Nullable, float, decimal, compound, JSON, computed and ingestion-metadata keys are rejected.
- Equality follows stored ClickHouse types: `"01"` and `1` become the same `UInt64` key. Use exact strings or `bigint` outside JavaScript's safe integer range.

### Supported publication scope

- Only **plain `MergeTree` in an `Atomic` database on one pinned server**, with read-your-writes visibility. No load balancer, Replicated, Shared, Distributed or replacing engines. EPHEMERAL and Nested/dotted columns are unsupported; retain `ingestionColumns` unchanged.
- All writers must use the same staged gate, executor object and identity policy within **one loaded package/process**. Staging may overlap; publication is serialized per qualified destination. Direct/simple/custom writes bypass the gate, even on the same executor. Exclude competing processes, executor instances, external writes and schema changes, including scratch replacement.
- The SQL user must see every destination key: restrictive row policies or stale reads defeat deduplication. The local gate is not a distributed lock or cross-process uniqueness constraint.
- Publication is not a transaction over scratch, destination and journal. A multi-block/partition failure may leave rows; replay fills missing keys only after the query terminates. Failed materialized views may remain incomplete because accepted base-table keys suppress replay; recover derived tables separately. Server power-loss durability and managed/replicated consistency are not guaranteed.

### Cost and default timing

- Each batch adds schema reads, CREATE/DROP DDL, scratch writes/storage, sorting, a candidate-key set, a destination anti-join and publication. Candidate filtering reduces join memory, **not scan guarantees**: every batch may still scan all destination keys. A sorting key is not a uniqueness index.
- Scratch preserves **all columns and their default/computed expressions**. Ordinary `DEFAULT` values resolve at staging; materialized/alias expressions and `_chkit_ingested_at` are evaluated again at publication. A separate default copying ingestion time retains its staging-time value; supply explicit stable values or suitable destination expressions when this matters.
- Materialized columns are computed and stored in scratch even without dependent defaults: expensive expressions and storage can occur twice. Measure row width, destination size, duplicate ratio and replay cost before paying this overhead.
- `maxRowsPerInsert` (default `50_000`) sizes scratch transport without changing winners. Stream `batchSize` controls logical publication: larger batches amortize DDL/scans but increase scratch/sort memory and checkpoint latency. Changing logical batch boundaries can change winners; pull-based buffering is not a hard RAM bound.
- Resource limits remain active with strict overflow errors; truncated reads, sorts, sets or joins must not checkpoint incomplete results. Staging also disables JSONEachRow error skipping.

### Supply SQL capabilities explicitly

- The ordinary loader context stays insert-only. `createStagedLoaderExecutor` supplies stateless SQL access; custom executors must honor synchronous settings and return complete results.
- Its user needs destination SELECT/INSERT, scratch CREATE/INSERT/SELECT/DROP in the same database, metadata/query-log reads, and permission for synchronous, strict-result and logging settings. Permission failures are not bypassed.
- The caller owns and closes the executor, wiring publication and journal to the same target. **CLI `--config` neither rebinds nor closes a captured loader executor**; there is no implicit connection injection.

### Minimal example

Migrate this destination with the [schema migration workflow](/tutorials/first-schema/), then run `bun sync-events.ts`. The two files form one example; replace the fixture reader with bounded provider pages.

```ts
// schema/events.ts
import { table } from '@chkit/core'
import { ingestionColumns } from '@chkit/plugin-ingest'

export const eventVersions = table({
  database: 'analytics',
  name: 'event_versions',
  columns: [
    { name: 'account_id', type: 'String' },
    { name: 'event_id', type: 'String' },
    { name: 'version', type: 'String' },
    { name: 'payload', type: 'String' },
    ...ingestionColumns,
  ],
  engine: 'MergeTree()',
  orderBy: ['account_id', 'event_id', 'version'],
})
```

```ts
// sync-events.ts
import {
  createClickHouseDestination, createClickHouseJournal,
  createStagedLoaderExecutor, definePipeline, defineStream,
  runIngestion, selectStreams, stagedLoader,
} from '@chkit/plugin-ingest'
import { eventVersions } from './schema/events.js'

const executor = createStagedLoaderExecutor({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
  database: 'analytics',
})

const events = defineStream({
  id: 'account-a.events',
  destination: eventVersions,
  loader: stagedLoader({
    executor,
    keys: ['account_id', 'event_id', 'version'],
    winner: 'first',
    concurrency: 'single-process',
  }),
  async *read() {
    yield { rows: [
      { account_id: 'a', event_id: 'evt-1', version: '1', payload: '{"status":"created"}' },
      { account_id: 'a', event_id: 'evt-1', version: '1', payload: '{"status":"created"}' },
    ] }
  },
})
const pipeline = definePipeline({ id: 'account-a', streams: [events] })

try {
  const result = await runIngestion(
    { selected: selectStreams([pipeline], []), backfill: undefined },
    {
      destination: createClickHouseDestination(executor),
      journal: createClickHouseJournal({ executor, database: 'analytics', targetId: 'local-analytics' }),
    },
  )
  if (!result.ok) process.exitCode = 1
} finally {
  await executor.close()
}
```

### Recovery and cleanup

- A missing ACK requires terminal `system.query_log` evidence: finished means success; failed permits replay. **Unknown/running/unobservable publication retains scratch, fences later publication on that executor and cannot advance progress.** Unsampled terminal logging, access and sufficient retention are required. A request that never reached the server has no terminal event; operator reconciliation is required, not blind resubmission.
- `reconciliationTimeoutMs` defaults to `30_000` per attempt, at most `2_147_483_647` ms. It bounds observation, including hung status reads, **not SQL execution**.
- Cancellation prevents a receipt once observed but cannot undo published rows or stop server SQL by disconnecting. **Before restart, quiesce the old process and wait for or terminate its publication queries**, then replay the journaled checkpoint. The fence does not survive across processes.
- Replay restages into a new random-UUID scratch table. Native block deduplication is disabled so reslicing and changed anti-join results cannot suppress needed rows.
- Cleanup verifies UUID ownership; failures fail the attempt and may block progress. Crashes or lost CREATE ACKs can orphan `_chkit_stage_*` tables. Stop writers, inspect `system.tables` and active `chkit-stage-*` queries, then drop only confirmed abandoned tables—never delete by prefix while writers are active.
- Empty batches need no SQL (`none_required`); nonempty, fully filtered batches still have publication evidence. Receipt/journal `rows` counts accepted **input rows**, not newly inserted rows; `writeUnits` counts publication, not scratch inserts.

## Tune insert size when needed

Start with the defaults. If measured request size or memory use requires smaller physical inserts, import `simpleLoader` from `@chkit/plugin-ingest` and set `loader: simpleLoader({ maxRowsPerInsert: 20_000 })` on the stream. This configures the same loader; it does not change mapping or checkpoint behavior.

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

## Batch identity

Without a chunk `id`, batch identity includes row content. This prefers a possible duplicate over suppressing data that changed between attempts. Adding a volatile field such as `synced_at: new Date()` changes identity on replay; use destination-owned ingestion time instead.

<details>
<summary>Use explicit chunk identity only for stable source intervals</summary>

Set `SourceChunk.id` only when it identifies a stable logical source interval whose replay is the same write. It is not a record primary key or a checkpoint. Explicit IDs make a chunk its own load batch and exclude row content from its identity; an offset into a changing dataset is not necessarily a stable interval.

Successful syncs rotate the identity cycle so subsequent updates can load. Failed/interrupted syncs retain their replay cycle. With `simpleLoader`, native suppression depends on the destination's engine, settings, and retention window. `stagedLoader` instead uses retained row keys within its publication contract. Neither is a universal exactly-once guarantee.

</details>

## Custom loader contract

<details>
<summary>Extend publication only when direct inserts are insufficient</summary>

`LoaderFactory` is an extension interface for application code. There is no bundled snapshot-replacement or refreshing loader.

The executor constructs a loader for each batch attempt. Its context supplies `streamId`, `runId`, `table`, `destination`, and `signal`.

1. `write({ batchId, rows })` accepts the batch for direct writing or staging. Direct retry tokens should derive from stable write identity, not a new run ID or current time. Preserve runtime metadata and cancellation semantics; a scratch write is not publication.
2. `finalize()` returns `{ evidence, rows, writeUnits }` only after publication has completed. Use `clickhouse_ack` for acknowledged writes, or `none_required` when no write was needed. The executor trusts this receipt before journaling progress.
3. `abort(reason)` releases resources after failure. Already acknowledged direct writes cannot be withdrawn; replay must remain safe.

Use `context.destination.insert({ table, rows, token })` for direct ClickHouse writes. If a loader uses another publication mechanism, it must still establish the required write evidence before returning success. Do not claim durability for queued, fire-and-forget, or staged data.

The stream's `retry` policy controls source attempts and reader recovery. Load attempts have a separate fixed retry budget; setting stream `retry.retries` does not configure insert retries.

</details>

## Related pages

- [Destinations and transformations](/api-sync/destinations/): map rows without replacing the loader.
- [Incremental syncs](/api-sync/incremental-syncs/): when committed writes advance progress.
- [Test a source](/api-sync/testing/): simulate a failed write and replay.
