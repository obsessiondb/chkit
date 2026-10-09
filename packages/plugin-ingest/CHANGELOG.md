# @chkit/plugin-ingest

## 0.2.0-beta.9

### Patch Changes

- 2f53550: Support `MATERIALIZED`, `ALIAS`, and `EPHEMERAL` columns with a new `defaultKind` column field. `default` holds the value or `fn:` expression for every kind, and `EPHEMERAL` may omit it. SQL rendering, `pull`, snapshots, and drift keep the kind; validation reports `column_expression_required` and `column_default_kind_invalid`.

  - `DEFAULT`/`MATERIALIZED` expression changes emit `MODIFY COLUMN` with a warning that stored values are not rewritten, and removed expressions emit `REMOVE DEFAULT`/`REMOVE MATERIALIZED`. Conversions to or from `ALIAS`/`EPHEMERAL` fail `generate` with `column_kind_change_unsupported`.
  - Codegen emits `Row` (`SELECT *`), `RowExplicit` (all readable columns), and `RowInsert` (all insertable columns) for these tables; ingest helpers take `RowInsert`.
  - Inserts into tables with `EPHEMERAL` columns name their columns: generated ingest helpers pass `columns`, which `@chkit/clickhouse` `insert()` and the ObsessionDB remote executor send, and the `@chkit/plugin-ingest` destination does the same.
  - Automatic backfills omit `MATERIALIZED` and `ALIAS` columns and check live column kinds first: a copy is blocked only when the target has both `EPHEMERAL` and `MATERIALIZED` columns, `mv_replay` by any `EPHEMERAL` column, and a missing target fails with "does not exist or is not visible yet".
  - `drift` and `check` compare defaults token by token. Write expressions in the canonical form ClickHouse stores, such as `CAST(x, 'String')`, to avoid drift.
  - Fix string defaults containing backslashes: `C:\temp` now renders as `DEFAULT 'C:\\temp'`.

- b59fc83: Write a newly planned unit of work and its first attempt to the ingestion journal in one atomic insert, which cuts one journal insert per stream run. `Journal.append` now takes an array of events, and a custom journal must write the whole array atomically.
- b59fc83: When two runs claim the same journal sequence numbers, the journal error now names the run to keep and prints the `DELETE` statement that removes the later run's facts.
- Updated dependencies [d072fe3]
- Updated dependencies [2f53550]
- Updated dependencies [98e3667]
- Updated dependencies [96a18c6]
- Updated dependencies [46cbf88]
- Updated dependencies [46cbf88]
- Updated dependencies [b59fc83]
- Updated dependencies [c49f0a9]
- Updated dependencies [672d67e]
  - @chkit/core@0.2.0-beta.9
  - @chkit/clickhouse@0.2.0-beta.9

## 0.2.0-beta.8

### Patch Changes

- 3042c56: Point README documentation links at the renamed API Sync section (`/api-sync/`).
- cffcbd9: Harden the ingestion journal on replicated and managed ClickHouse (such as ObsessionDB). `ensure()` now waits until the journal table is visible after creating it. The run-level `run_started` and `run_finished` facts get the same bounded retry as stream facts, so one transient error, such as a lagging replica that doesn't know the journal table yet, no longer fails the whole run. Terminal facts (`work_finished`, `run_finished`) are no longer cut off after a fixed 5 seconds while the run is still live, so a slow but healthy journal write no longer turns a successful run into a `TimeoutError`. The 5-second grace still applies once a run is cancelled or its execution budget runs out.
- 97949a3: Each ingestion run now journals its `run_started` and `run_finished` facts under its own `@run:<run id>` namespace. Previously every run shared one `@run` namespace, so two executor processes that overlapped once (for example a local run during a scheduled one) left conflicting facts at the same sequence number and every later run refused to start. Stream checkpoints were never affected; per-stream namespaces still detect overlap.
- f8238db: Add `@chkit/plugin-ingest`, the first cut of scheduled pull ingestion into ClickHouse. Streams are ordinary TypeScript: a `read` async generator fetches, maps, and yields destination-shaped rows, and `definePipeline` returns a tagged, non-durable group of streams; only pipelines exported from the project entry participate, with no global registry. `chkit ingest run` executes the selected streams (`--tag` is repeatable with exact AND semantics; an explicit empty selection fails), `chkit ingest list` shows the loaded graph, and `chkit ingest status` prints committed checkpoints.

  Progress follows one rule: rows are saved before the bookmark advances. Every batch is written with a stable `insert_deduplication_token`, and only after the ClickHouse acknowledgement does the executor append a `batch_committed` fact to the append-only ingestion journal. Checkpoints are a projection of that journal, so a crashed or lost-acknowledgement run replays from the last durable boundary with the same batch identity instead of skipping rows. Bundled strategies are `timestampWindow({ start, overlapMs })` (with a custom `from` callback alternative), `cursorState` for provider-owned state, and the full-sync fallback; `--backfill <id>` runs an explicit range in an isolated checkpoint namespace.

  `rawTable` and `rawRows` land provider objects untouched in a native `JSON` column, so typed shapes are derived inside ClickHouse with ordinary views or materialized views instead of being mapped in pipeline code.

  `FetchContext` exposes source request and cancellation capabilities independently of checkpoint types; `ReadContext` extends it.

  Source operations run through `context.attempt`, which owns fetch permits, p-retry-shaped retry policy, `Retry-After`, cancellation, and failure classification (`HttpError.fromResponse` is the canonical boundary for fetch-based readers). Pipelines carry separate `maxStreams`, `maxFetches`, and `maxLoads` ceilings, executions have a duration budget, and the executor emits OpenTelemetry spans.

  `@chkit/core` gains a singular `entry` config field, mutually exclusive with `schema` globs: the module is imported once, its exported schema definitions are collected, and exported plugin-domain definitions are collected by their plugins. `@chkit/clickhouse` `insert()` accepts per-insert `settings`.

  Successful syncs rotate batch identity using the existing journal, while failed runs retain their replay identity. Execution cancellation also bounds journal I/O, stalled writes cannot report success, and loader construction failures release their permits. Ingestion requires a direct ClickHouse connection; incompatible host executors fail before any writes. Project `entry` and `schema` settings replace the inherited source mode when layering configuration.

- Updated dependencies [65c90d6]
- Updated dependencies [75d15e9]
- Updated dependencies [3f1db03]
- Updated dependencies [f8238db]
- Updated dependencies [fedbf56]
- Updated dependencies [5a8d805]
- Updated dependencies [8296b8a]
- Updated dependencies [b501f5d]
- Updated dependencies [256ec62]
  - @chkit/core@0.2.0-beta.8
  - @chkit/clickhouse@0.2.0-beta.8
