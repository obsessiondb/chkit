---
title: Loading and batching
description: Choose direct inserts or opt-in staged deduplication, with explicit identity, concurrency and recovery limits.
---

A loader writes the rows yielded by the reader, whether they contain raw objects or mapped columns.

## Start with the default loader

Omit `loader` from the stream definition, as in the [quickstart](/api-sync/quickstart/). chkit uses `simpleLoader()` to insert rows and attach ingestion metadata. Use this for both raw and shaped storage, including rows with embedded children.

`simpleLoader` makes direct, at-least-once inserts, adds ingestion metadata, and splits a load batch into deterministic write units with stable deduplication tokens. Native suppression depends on engine settings and a finite token-retention window; it does not deduplicate logical records across arbitrary overlaps. Use the optional `stagedLoader` below when explicit row-key deduplication is needed and its publication contract fits. Neither loader replaces a whole destination snapshot atomically.

Changing raw JSON to typed rows, changing a SQL view, using an SDK, or tuning concurrency does not require a custom loader.

## Opt into staged deduplication

`stagedLoader` writes a logical batch into a private scratch table, selects one winner per key, filters keys already present in the destination, and publishes the remaining rows with `INSERT SELECT`. Only then may the executor journal progress. Staging alone is never sink evidence. The policy is optional; the default remains `simpleLoader`.

Choose it for immutable events or observations with stable identities, overlapping source windows, and retries that may outlast native INSERT-token retention. Choose direct append-only writes when duplicates are acceptable or reconciled downstream. Choose replacing/current-state storage and appropriate read semantics for mutable entities. Staged insert-if-absent is not an upsert or deletion reconciler.

### Identity and winners

| Identity | Example | Meaning |
|---|---|---|
| Entity | `['account_id', 'id']` | Keep the first published entity; later changed payloads are filtered out. |
| Version/content | `['account_id', 'id', 'version']` | Retain each distinct observation; a stable content hash can replace a source version. |
| Transport | `SourceChunk.id`, batch ID, physical query ID | Identify replay or one SQL operation, not logical record equality. |

`keys` must be nonempty, distinct, writable, non-null scalar column names. Supported key types are `String`, `FixedString`, signed/unsigned integers, `UUID`, `IPv4`/`IPv6`, `Date`/`Date32`, and `DateTime`/`DateTime64`, including compatible `LowCardinality` wrappers. `Nullable`, floating-point, decimal, array, tuple, map, JSON, computed and ingestion-metadata keys are rejected. Every input row must explicitly supply its keys; defaults cannot invent identity. Use exact strings or `bigint` for integers outside JavaScript's safe range. Equality follows stored ClickHouse types: `"01"` and `1` become the same `UInt64` key. Null payload fields are independent of key nullability.

`winner: 'first' | 'last'` chooses by input position **within the logical batch**, across all physical staging inserts. Equal-key ties are deterministic for the same ordered input; this is not globally newest-by-timestamp. Keep reader ordering stable on replay, or sort a bounded source unit explicitly. Destination keys always win over staging, even when their payload differs. Include a version/hash in the key when that difference matters. The loader does not remove duplicates already stored in the destination, and deduplication lasts only while the keys remain there; TTL or manual deletion makes them eligible again.

### Supply SQL capabilities explicitly

The ordinary loader context remains insert-only. `stagedLoader` takes an explicitly supplied SQL executor; `createStagedLoaderExecutor` constructs a stateless one without installing an internal package. Reuse that exact object across every staged writer to the same server, and close it when its owner finishes. Custom implementations must honor synchronous submission settings and provide complete query results.

The SQL user needs destination SELECT/INSERT, scratch CREATE/INSERT/SELECT/DROP in the same database, metadata reads, and query-log reads for recovery. Its profile must permit the supplied synchronous, strict-result and logging settings; permission failures are not silently bypassed.

The example below uses programmatic `runIngestion` so publication, destination and journal share one explicit connection. A loader captured in a CLI schema module still owns its own connection: `--config` does not rebind or close that executor. Do not mix a captured loader target with a different CLI journal target; the caller must wire and manage both consistently. There is no implicit connection lookup or host-capability injection.

Define and migrate a plain MergeTree destination first, using the usual [schema migration workflow](/tutorials/first-schema/):

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

This complete program demonstrates the loader and executor lifetime; replace the fixture reader with bounded provider pages:

```ts
// sync-events.ts
import {
  createClickHouseDestination, createClickHouseJournal,
  createStagedLoaderExecutor, definePipeline, defineStream,
  fullSync, runIngestion, selectStreams, stagedLoader,
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
  incremental: fullSync(),
  loader: stagedLoader({
    executor,
    keys: ['account_id', 'event_id', 'version'],
    winner: 'first',
    concurrency: 'single-process',
    maxRowsPerInsert: 10_000,
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

### Supported publication scope

The destination must be a **plain `MergeTree` in an `Atomic` database on one pinned server**, with read-your-writes visibility. Replicated, Shared, Distributed, replacing and other engines are rejected. EPHEMERAL and Nested/dotted columns are unsupported. Keep `ingestionColumns` unchanged, including its publication-time default. This is intentionally narrower than the default loader's destination support.

`concurrency: 'single-process'` acknowledges an operational contract, not a distributed lock. Publication is serialized per executor object and qualified destination within one loaded package/process. Different streams and factories sharing that object may stage concurrently, but publish in turn. All destination writers must use this staged-loader gate and the same identity policy: sharing an executor with `simpleLoader`, custom loaders or direct INSERTs does not serialize those writes. Exclude other processes, executor instances, external writes, and schema changes, including scratch-table replacement. The SQL user must see every destination key; restrictive row policies defeat the anti-join. A load-balanced endpoint or stale replica read can miss existing keys. Two independent anti-joins can both see a key as absent and both insert it.

“Commit” means an acknowledged publication operation, **not a ClickHouse transaction over staging, destination and journal**. A multi-block or multi-partition publication may partially succeed. Replay after it has terminated filters the visible keys and fills the remainder. A failed materialized view can miss rows after the base table accepts them; the anti-join can then prevent replay from repairing that view. Use a separately recoverable derived-table strategy when downstream completeness matters. Server power-loss durability and replicated/managed-service consistency are not guaranteed by this loader.

### Recovery and cleanup

Each attempt owns a random scratch table UUID; it never reuses a batch-named table or drops another attempt's scratch. A fresh replay restages the source. Staging insert size may change without changing winner order or losing rows to reused physical INSERT tokens. Publication disables native block deduplication because the anti-filtered result may differ on retry.

On a missing publication ACK, the loader waits for a terminal `system.query_log` event, including failures before execution. A finished query can establish sink evidence; a failed query permits replay. Unknown, still-running or unobservable work remains fenced within that executor, retains its scratch table, and does not advance progress. `reconciliationTimeoutMs` defaults to 30,000 per attempt and cannot exceed Node's 2,147,483,647 ms timer limit; it bounds reconciliation waiting, including a hanging status read, not the original SQL execution time. The loader requests unsampled terminal logging; server query-log configuration, access and sufficient retention are required for ambiguous-ACK recovery. A request that never reached the server has no terminal event and requires operator reconciliation rather than assuming it is safe to resubmit.

Cancellation prevents a receipt after the signal is observed, but cannot roll back already published rows or assume an HTTP disconnect stopped the server. Before restarting in another process, quiesce the old process and wait for or terminate its server-side publication queries. A new process has no distributed fence against old work. Then replay from the journaled checkpoint.

Cleanup checks the scratch UUID before dropping it. Cleanup errors fail the attempt instead of silently leaking tables; replay remains safe within the contract, but persistent cleanup errors block progress. A lost CREATE acknowledgement or a crash can leave `_chkit_stage_*` orphans. Inspect `system.tables` and active `chkit-stage-*` query IDs with writers stopped; delete only confirmed abandoned scratch tables. Never use prefix-wide deletion while writers might be active.

An empty batch needs no SQL and returns `none_required`. A nonempty, entirely filtered batch still has acknowledged publication evidence. Receipt/journal `rows` counts accepted **input rows**, including duplicates filtered out; it is not the count newly inserted. `writeUnits` counts the publication operation, not scratch inserts.

### Cost and tuning

Staging adds schema reads, CREATE/DROP DDL, one or more scratch writes, a sort for winner selection, a candidate-key set, a destination-key anti-join, and a destination write. The destination side is filtered to this batch's keys before building the join, reducing the join's retained rows; constructing that set adds another scratch-key read. This is not a scan guarantee: the query can still read all destination keys per logical batch, even with a matching sorting key. The sorting key is not a uniqueness index. Scratch storage temporarily holds the full batch, and server memory/latency grows with the sort, candidate set and join. Source buffering remains pull-based, not a hard RAM bound. Resource limits remain active, but strict overflow modes force errors rather than accepting truncated reads/sorts/sets/joins. Staging also disables JSONEachRow error skipping; a partial acknowledgement must not masquerade as complete input coverage.

Small batches amortize DDL poorly; large/wide batches cost more scratch space and sorting memory. Start with `simpleLoader` when these costs buy no needed guarantee. Measure the actual destination size, row width, duplicate ratio and replay cost before selecting staging. `maxRowsPerInsert` (default 50,000) changes scratch transport sizing; stream `batchSize` controls the logical publication boundary. Larger batches reduce repeated scans but delay checkpoints, and changing logical batch boundaries can change which payload wins. Repository contributors can reproduce local boundary tests with `bun run test:staged-loader`; they are also part of `bun run verify`. These tests use disposable local databases regardless of managed target environment variables.

## Tune insert size when needed

Start with the defaults. If measured request size or memory use requires smaller physical inserts, import `simpleLoader` from `@chkit/plugin-ingest` and set `loader: simpleLoader({ maxRowsPerInsert: 20_000 })` on the stream. This configures the same loader; it does not change mapping or checkpoint behavior.

Keep `simpleLoader`'s physical insert sizing stable while replaying interrupted work: its tokens identify write units, not row keys. Use staged publication when deduplication must survive physical reslicing, within the identity and concurrency contract above.

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
