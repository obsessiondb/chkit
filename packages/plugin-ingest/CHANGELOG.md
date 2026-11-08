# @chkit/plugin-ingest

## 0.2.0-beta.14

### Patch Changes

- Updated dependencies: `@chkit/core@0.2.0-beta.14`, `@chkit/clickhouse@0.2.0-beta.14`

## 0.2.0-beta.13

### Patch Changes

- 8c01425: `chkit ingest doctor` and `chkit ingest repair` stream the journal table instead of loading it whole, so their memory grows with the selected stream's history rather than with the whole journal.
- 10c2676: With `clickhouse.cluster` set, `chkit ingest run` creates its journal as one `ReplicatedMergeTree` on every replica and refuses to run on a journal that is not.

  - Breaking: on a cluster, a local journal an earlier version created now fails `ingest run`; copy its rows into a replicated journal and set `journalTable` to it.

- bdf8a2d: A rate-limit hint too far in the future for a `Date` no longer fails the stream with "Invalid time value"; ingestion waits it out like any other long hint.
- c467d57: Ingestion no longer silently drops row fields the destination has no column for: they land in a `_chkit_rest` JSON column when the table declares one, and the run logs their names.

  - Breaking: without `_chkit_rest`, a yielded field with no column fails the stream; map it to a column or declare `_chkit_rest`.

- Updated dependencies: `@chkit/core@0.2.0-beta.13`, `@chkit/clickhouse@0.2.0-beta.13`

## 0.2.0-beta.12

### Patch Changes

- d48915f: Invalid checkpoint strategy ids or versions and invalid planned timestamp bounds now fail when a stream runs, and `Date` objects from another realm are no longer accepted.
- 684428d: Invalid ingestion definitions and host limits, such as a missing `read` or a non-integer or out-of-range budget, are reported as configuration errors instead of failing the first run or ending it before the first fetch.

  Breaking: declared tags may no longer start with `stream:` or `pipeline:`.

- 0771d42: A reader's retained `context.fetch` and `context.attempt` now reject once the reader ends, a custom iterator whose `return()` throws no longer replaces the stream's outcome, and a large `Retry-After` no longer causes repeated one-millisecond waits and warnings.
- 6f8a34c: Streams that yield chunks above roughly 125,000 rows no longer crash Node with "Maximum call stack size exceeded".
- 9e55a96: Ingestion loading keeps rows and values intact in more cases:

  - Invalid `maxRowsPerInsert` values are rejected instead of hanging or silently dropping rows, and replaying a batch with a different insert size can no longer skip unsaved rows.
  - DateTime and DateTime64 columns accept ISO timestamps and `Date` objects, and JSONEachRow keeps non-finite floats and `Map`s; a non-finite number aimed at a non-float column now fails or lands as text instead of becoming zero or null.
  - Missing declared ingestion metadata and unflattened Nested inputs are rejected.
  - In native JSON columns, space-separated timestamp strings that used to be inferred as DateTime now stay String, so a path can hold both types across older and newer rows.
  - Upgrade: batch hashes and deduplication tokens changed, so an interrupted run replayed across the upgrade can insert duplicates once; do not recover one run with both old and new loaders.

- 4c0b805: Ingestion retries only transient failures, at the request:

  - Network errors, timeouts and HTTP 408, 425, 429 and 5xx are retried; any other failure fails the stream at once, and the next run resumes from the last checkpoint instead of restarting the stream within the run.
  - Readers get `context.fetch`, which shares the pipeline's request queue (a `Retry-After` pauses every request of the pipeline), retries transient failures, aborts after 30 seconds and throws `HttpError` for unsuccessful responses.
  - `HttpError.withStatus(response, status, { retryAfterMs })` marks a failure the classification cannot see, such as a rate limit reported as 403.
  - An invalid ingestion definition no longer breaks `generate` or `migrate`; it is reported when an ingest command selects the pipeline and by `chkit check` as `ingest_invalid_pipeline`.
  - `@chkit/plugin-ingest/testing` adds `createSourceContext` and `createReadContext` for testing a client or reader directly.
  - Breaking: `classifyError` is removed; map rate limits with `HttpError.withStatus`.
  - Breaking: `FetchContext` is now `SourceContext`, `context.attempt` rejects with the original error, and `retry` moved to `runIngestion` without `shouldRetry`, `shouldConsumeRetry` or `factor`.
  - Breaking: `FetchFailure`, `IngestConfigError`, `ErrorClassifier` and `FailureClass` are no longer exported.

- 31702ac: `chkit ingest status` only reads, so read-only users can run it; without a journal table it reports `v0 (no checkpoint)` instead of creating one.
- b58b1d2: New opt-in `stagedLoader` stages each batch, keeps one row per key and inserts only keys missing from a single-server MergeTree destination; `simpleLoader` remains the default.
- Updated dependencies: `@chkit/core@0.2.0-beta.12`, `@chkit/clickhouse@0.2.0-beta.12`

## 0.2.0-beta.11

### Patch Changes

- Updated dependencies [889969d]
  - @chkit/core@0.2.0-beta.11
  - @chkit/clickhouse@0.2.0-beta.11

## 0.2.0-beta.10

### Patch Changes

- ba4f762: Allow registry resources to declare cursor checkpoints and timestamp windows alongside full scans. Upgrade the eight raw API integrations with provider-specific sync tokens, overlapping incremental ranges, and safe restart recovery, while preserving historical registry releases. Use one pipeline per installation with independent resource or configured collection streams, editable configuration, injectable clients, and meaningful resource readers. Attio creates independent object-type and list streams using existing full-sync pagination, with People and Companies enabled by default. GitHub separates eight raw resource types per repository, including independent issues, PRs, comments, reviews, and SHA/message commits with warehouse join keys; it no longer fetches PR files or assembles child arrays. Resources without reliable change filters use built-in full-sync completion; Calendar tokens and Lemlist activity intervals retain their necessary recovery state. Meet and Slack use recent rediscovery and coarse completed-page checkpoints, replaying unfinished children without retained-work queues. Circleback independently reads meetings, complete transcript snapshots, action items, people, and companies with replay-safe full pagination.

  Update the ingestion authoring skill with the registry sync quality bar, provider capability selection, meaningful stream boundaries, normalized raw ingestion by default with transformations and joins in ClickHouse, existing pagination/checkpoint primitives, coarse replay where affordable, explicit freshness coverage, durable recovery rules, and required failure/restart verification.

  Linear syncs issues, comments, projects, project updates, cycles, users, teams, issue relations, and issue history into nine independent raw destinations. Seven resources own update-time windows; relations and history use complete full reads, with history discovering all issues independently of parent progress. Preserve raw relationship IDs and complete issue label names as strings, and leave joins and metrics to ClickHouse. Populate new destinations independently and migrate retained legacy nested comments deliberately.

  Treat repeated pagination continuations as permanent provider-protocol errors so reader retries cannot repeatedly replay a cyclic collection.

  Add per-integration changelog metadata, shown in registry inspection and integration guides. Keep one draft release per integration in each PR, refresh it in place until merge, and validate release artifacts against the PR base to protect published versions and changelog history.

- afccf6a: Support overlapping ingestion processes with run-scoped journal event identities and validated checkpoint lineage stored entirely in ClickHouse. Stale reads and lost acknowledgements safely replay work without reallocating another run's event identities. Retain valid acknowledged progress when a run has malformed trailing evidence.

  Add read-only `ingest doctor` and fingerprint-reviewed `ingest repair`. Recovery preserves a verified full archive and materializes a replacement journal without changing the active configuration. Stop writers, review the snapshot, and explicitly configure the returned journal table before restarting; other namespaces remain intact.

- e3a81c8: Change `paginate()` to yield full `{ items, next, metadata? }` pages, including empty and terminal pages. This is a breaking return-type change: readers must consume `page.items` instead of treating a page as an item array. Metadata passes through unchanged and readers can explicitly map it to checkpoint state, which the existing executor commits after destination acknowledgement. Reject repeated continuations before yielding candidate progress, including a continuation back to the initial cursor. Migrate registry readers and use page metadata for Google Calendar sync-token checkpoints without changing their saved state format.

  Simplify Calendar token recovery into the same checkpointed pagination loop and Slack temporary message pagination through full pages with native completion metadata. Remove provider cursor-equality checks now covered by the shared paginator, retaining provider validation, durable timestamp frontiers, and bounded recovery.

- Updated dependencies [cb56b91]
- Updated dependencies [76a0579]
- Updated dependencies [3c546e8]
  - @chkit/clickhouse@0.2.0-beta.10
  - @chkit/core@0.2.0-beta.10

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
