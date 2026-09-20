---
"@chkit/plugin-ingest": patch
"@chkit/clickhouse": patch
"@chkit/core": patch
"chkit": patch
---

Add `@chkit/plugin-ingest`, the first cut of scheduled pull ingestion into ClickHouse. Streams are ordinary TypeScript: a `read` async generator fetches, maps, and yields destination-shaped rows, and `definePipeline` returns a tagged, non-durable group of streams; only pipelines exported from the project entry participate, with no global registry. `chkit ingest run` executes the selected streams (`--tag` is repeatable with exact AND semantics; an explicit empty selection fails), `chkit ingest list` shows the loaded graph, and `chkit ingest status` prints committed checkpoints.

Progress follows one rule: rows are saved before the bookmark advances. Every batch is written with a stable `insert_deduplication_token`, and only after the ClickHouse acknowledgement does the executor append a `batch_committed` fact to the append-only ingestion journal. Checkpoints are a projection of that journal, so a crashed or lost-acknowledgement run replays from the last durable boundary with the same batch identity instead of skipping rows. Bundled strategies are `timestampWindow({ start, overlapMs })` (with a custom `from` callback alternative), `cursorState` for provider-owned state, and the full-sync fallback; `--backfill <id>` runs an explicit range in an isolated checkpoint namespace.

`rawTable` and `rawRows` land provider objects untouched in a native `JSON` column, so typed shapes are derived inside ClickHouse with ordinary views or materialized views instead of being mapped in pipeline code.

`FetchContext` exposes source request and cancellation capabilities independently of checkpoint types; `ReadContext` extends it.

Source operations run through `context.attempt`, which owns fetch permits, p-retry-shaped retry policy, `Retry-After`, cancellation, and failure classification (`HttpError.fromResponse` is the canonical boundary for fetch-based readers). Pipelines carry separate `maxStreams`, `maxFetches`, and `maxLoads` ceilings, executions have a duration budget, and the executor emits OpenTelemetry spans.

`@chkit/core` gains a singular `entry` config field, mutually exclusive with `schema` globs: the module is imported once, its exported schema definitions are collected, and exported plugin-domain definitions are collected by their plugins. `@chkit/clickhouse` `insert()` accepts per-insert `settings`.

Successful syncs rotate batch identity using the existing journal, while failed runs retain their replay identity. Execution cancellation also bounds journal I/O, stalled writes cannot report success, and loader construction failures release their permits. Ingestion requires a direct ClickHouse connection; incompatible host executors fail before any writes. Project `entry` and `schema` settings replace the inherited source mode when layering configuration.
