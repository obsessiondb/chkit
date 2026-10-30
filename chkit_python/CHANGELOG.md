# Changelog

## Unreleased

### Added
- `chkit migrate --setting <name=value>` (optional, repeatable, or comma-separated) sends
  ClickHouse query settings with every statement a migration runs (#321): synchronous
  statements, `mode=async` submissions, `mode=barrier` reads and `-- before-retry:` SQL,
  e.g. `--setting max_table_size_to_drop=0` to drop a table larger than the server's size
  limit. Without it no settings are sent; journal and polling queries never get them.
  `ClickHouseClient.execute()`/`submit()` and the ObsessionDB remote client take optional
  settings.
- `chkit generate --cutover <db.table>=<key>[,<key>]` (repeatable) plans a zero-downtime
  cutover of a structural change (engine, ORDER BY, PRIMARY KEY, PARTITION BY) instead of
  DROP + CREATE (#202): a shadow table with the new definition, a mirror materialized
  view, insert barriers, an `ATTACH PARTITION ALL` snapshot, a key-based copy, a per-key
  verification, a guarded `EXCHANGE TABLES` (operation `exchange_tables`, risk `caution`)
  and a reconcile of rows an INSERT racing the swap left in the old table.
  `--cutover-copy backfill` leaves the copy to `chkit plugin backfill plan|submit
  --cutover <db.table>`; `--cutover-old keep|drop` keeps the old table as
  `<table>_previous` (recorded in the snapshot with `retainedBy`, so `generate`, `drift`
  and `check` treat it as managed) or drops it. `--drop-retained <db.table>` plans its
  drop later. Unsupported changes fail with `cutover_unsupported`.
- Migration operations render `mode=` on their marker and a `-- before-retry:` line.
  `migrate` now runs a synchronous statement's `-- before-retry:` SQL before it retries
  the statement (it ran only for `mode=async` before), and before retrying an
  `EXCHANGE TABLES` waits until every replica agrees on both tables. `mode=barrier`
  statements wait for the INSERTs running at their first read
  (`chkit.clickhouse.insert_barrier`). After an `EXCHANGE TABLES` on a multi-replica
  target without `clickhouse.cluster`, `migrate` waits for every replica to list the
  swapped tables.
- The cutover (#202) now refuses fire-and-forget async inserts (`async_insert = 1`,
  `wait_for_async_insert = 0`) into the table at its first step and before the `EXCHANGE
  TABLES`, a table TTL, table or column renames, new CHECK constraints, Buffer tables and
  streaming sources behind intermediate tables that write into the table, dependent views
  recreated in the same migration, and Replicated tables without `clickhouse.cluster`;
  `migrate` stops when the swap has not reached every replica. The verify step compares
  rows with NULL columns, and `snapshot rebuild` keeps tables retained by a keep-mode
  cutover.
- `SkipIndexVectorSimilarity` (`type="vector_similarity"`: `method`, `distanceFunction`,
  optional `dimensions` and the three HNSW tuning fields, validated as
  `vector_index_invalid_parameters`), `SkipIndexRaw` (`type="raw"`, `rawType` rendered
  verbatim) and table `constraints=[TableConstraintDefinition(name=..., check=...|assume=...)]`
  (#278). Constraints render in `CREATE TABLE`, plan `ADD`/`DROP CONSTRAINT` (risk
  `caution`, with a warning; a changed one is dropped and re-added), get `ON CLUSTER`, and
  migrate waits until every replica shows them. `pull` and `drift --live` read both;
  drift reports `constraint_mismatch` with `constraint_diffs`.
- `chkit snapshot rebuild [--dryrun] [--json]` rewrites `snapshot.json` from the schema
  definitions after a merge or rebase conflict, reports added, removed and changed
  entries, and prints git review and restore commands.
- `migrate --retry <migration>` resumes a failed migration after its file was edited,
  skipping completed statements, and refuses edits that move or change a statement that
  already ran. `migrate --abandon <migration>` resets a failed migration so the next apply
  runs it from statement 1 (previews without `--apply`). An edited failed migration with
  no completed statement runs again from statement 1 without a flag.
- Every statement's progress is recorded in `_chkit_migrations`, so a re-run after a
  partial failure skips completed statements. Failures name the file, the statement
  number and the SQL, and `migrate --json` errors use the JSON error envelope.
- `chkit generate --empty` scaffolds a blank manual migration and leaves the snapshot
  untouched.
- `SQLExpression` column defaults (`default=SQLExpression(expression="now64(3)")` or
  `{"expression": ...}`) for every `default_kind`. Snapshots keep the `fn:` string, so
  switching spellings plans nothing. New validation codes
  `column_default_looks_like_expression` and `column_default_invalid`. `pull` writes
  `SQLExpression(...)` and `init` scaffolds it.
- `--force-shared-engines` / `--no-shared-engines` on `generate` and `snapshot rebuild`
  override ObsessionDB host detection for stripping `storage_policy`; `migrate`, `status`,
  `drift` and `check` accept and ignore them.
- backfill: `insert_settings` (`insertSettings`) plugin option, appended to every chunk
  INSERT's `SETTINGS` clause for local runs and ObsessionDB managed submit.
- Add `SkipIndexText` for full-text index generation, introspection, pull, and drift.
  Preserve quoted SQL literals, normalize ClickHouse’s fixed granularity, and reject
  malformed or unsupported metadata. Exercise adversarial round trips and actual
  indexed search results on ClickHouse 26.3 and 26.8.
- Native Kafka table definitions without sorting keys, escaped literal settings,
  pull round trips, and normalized live drift/check comparisons.
- Validation and migration guards reject unsupported Kafka changes before
  writing artifacts. Offline drift/check report changes requiring replacement;
  explicit drop/create migrations preserve the existing destructive-operation gate.
- Kafka ingestion and replacement integration tests on ClickHouse 25.3 and 26.3.
- `MATERIALIZED`, `ALIAS`, and `EPHEMERAL` columns via `default_kind` (alias
  `defaultKind`), kept through SQL rendering, introspection, pull, snapshots, and
  drift. Validation reports `column_expression_required`; an unknown kind is
  rejected when the column is constructed.
- `DEFAULT`/`MATERIALIZED` expression changes emit `MODIFY COLUMN` with a warning
  that stored values are not rewritten; removed expressions emit `REMOVE DEFAULT`
  or `REMOVE MATERIALIZED`. Conversions to or from `ALIAS`/`EPHEMERAL` fail with
  `column_kind_change_unsupported`.
- Codegen emits `Row`, `RowExplicit`, and `RowInsert` models for these tables.
- Automatic backfills omit `MATERIALIZED` and `ALIAS` columns and check live
  column kinds first: a copy is blocked only when the target has both
  `EPHEMERAL` and `MATERIALIZED` columns, `mv_replay` by any `EPHEMERAL` column,
  and a missing target fails with "does not exist or is not visible yet".
- Live drift compares defaults token by token. Write expressions in the
  canonical form ClickHouse stores, such as `CAST(x, 'String')`.
- `chkit plugin backfill submit --plan-id <id>` re-submits a saved plan whose
  ObsessionDB job failed or was cancelled (#313), and replaces the job ID in its
  submission file, so `chkit check` follows the new job instead of failing with
  `obsessiondb_backfill_job_failed`. Chunks whose task finished in that job are
  left out. It starts no job when the job is in any other state, the plan does
  not exist or was never submitted, or planning flags are passed with
  `--plan-id`. `--json` adds `planId`, `replacedJobId` and `skippedChunks`. The
  `obsessiondb_backfill_job_failed` finding now points to `submit --plan-id`. The
  backfill SDK exports `read_plan_submission`.

### Fixed
- `chkit plugin backfill plan --from/--to` now windows a table partitioned on a `Date`
  column (#352). `system.parts` reports `min_time`/`max_time` as 1970-01-01 for it and
  fills `min_date`/`max_date` instead, so any `--from` selected no partition ("No
  partitions found … The table may be empty") and `--to` alone selected all of them. The
  planner now falls back to `min_date`/`max_date`, with a partition's last day ending at
  23:59:59.
- `chkit plugin backfill plan --from/--to` no longer selects a partition outside the
  window because one of its active parts reports `min_time = 1970-01-01` in `system.parts`
  (#320). An empty part, such as one a DELETE mutation leaves, pulled the partition's
  earliest time to the epoch; zero `min_time` values are now ignored.
- `chkit drift` and `chkit generate` errors that exited without a message (no snapshot,
  invalid `--cutover`/`--rename-*`/`--drop-retained` flags, a failed codegen
  integration) now print it on stderr and, under `--json`, the error envelope on stdout,
  like the TS CLI (#342). A ClickHouse server error's envelope `code` is its exception
  code (e.g. `"60"`) instead of `"error"`. `status`, `drift`, `check` and `generate`
  `--json` output now starts with `command` and `schemaVersion`, as in TS.
- `chkit drift --live`, `status`, `migrate`, `check`, `query` and `pull` without a
  `clickhouse` block or a selected ObsessionDB service now exit 1 with the message on
  stderr (and the error envelope on stdout under `--json`), like the TS CLI, instead of
  exiting 2 with a usage error box (#354). Real usage errors, such as `query` without a
  SQL string, still exit 2.
- `chkit plugin backfill list --json` and `status --json` keep each job's `lastError` and
  `metadata` (#327). The job models dropped both, so the output lacked fields the TS CLI
  prints.
- A command that fails under `--json` now prints the TS CLI's error envelope
  (`{command, schemaVersion, ok: false, error: {code, message}}`) on stdout (#329).
  Before, only `migrate` and `snapshot` did; `query`, `status`, `check`, `drift` and
  `pull` left stdout empty. A failed `chkit query` (connection or SQL error) now exits 1
  with the message on stderr, like the TS CLI; it exited 2 with a usage error before.
- backfill: `chkit check` no longer passes a submitted backfill that nothing verifies
  (#326). Without the ObsessionDB plugin in the config, nothing asked the jobs API about
  a plan sent with `submit`, so the plan passed unchecked. The backfill check now reports
  submitted plans not yet confirmed completed as `backfill_submitted_unverified` when no
  ObsessionDB plugin is configured, with the same severity as `backfill_required_pending`.
- `chkit check` no longer requires a `clickhouse` block when you are logged in to
  ObsessionDB with a service selected (#325). The ObsessionDB plugin now has a
  `get_context` hook that returns the remote executor, as in TS, so `check` reads the
  journal and checks submitted backfills through the selected service; the service
  takes precedence over a `clickhouse` block, and `check` names it
  (`obsessiondb: using service "<name>"`, text mode only).
- The ObsessionDB plugin reads the selected service only from the project's
  `.chkit/obsessiondb.json`, as in TS (#343). It also fell back to a `"selected"` entry
  in the user-global `~/.config/chkit/obsessiondb.json`, so such an entry would have sent
  `check` (and backfill commands) to that service in every project with the plugin.
- `status`, `migrate`, `drift --live`, `query` and `pull` now run through the selected
  ObsessionDB service too, like `check` and the TS CLI (#340). They used only the
  `clickhouse` block, so a project with both a selected service and a `clickhouse`
  block split targets: `migrate` applied to the `clickhouse` block while `check` read
  the journal from the service and reported those migrations as pending. Every command
  that talks to ClickHouse now takes the plugin executor first, else the `clickhouse`
  block, and names the selected service in text mode. `migrate` now records
  `applied_at` without a zone suffix, as TS does: the ObsessionDB API rejected the
  journal row (`Cannot parse string ... as DateTime64(3, 'UTC')`). The
  `--service <name>` override is not ported yet.
- `chkit plugin backfill list` lists a managed service's backfill jobs (#311). The
  ObsessionDB plugin handled `list`, but the backfill plugin registered no `list`
  command, so the CLI rejected it before the hook ran. `--service-slug` is now optional
  and defaults to the selected service. Without the ObsessionDB plugin (or with
  `--local`), `list` exits 2 and explains how to set up a managed backend.
- backfill: the ObsessionDB managed `chkit plugin backfill submit` now applies the
  backfill plugin's options, as the local `plan` does (#309). It ignored
  `backfill({"stateDir": ...})` and saved the plan and the submission marker in the
  default `<metaDir>/backfill/`, while `chkit check` read the configured `stateDir`. Both
  now go to the configured `stateDir`, and the ObsessionDB check reads the markers from
  it. The other planning options (`maxChunkBytes`, `maxRetriesPerChunk`,
  `requireIdempotencyToken`, ...) now apply to `submit` too; flags still override them.
- `chkit plugin backfill status --job-id` and `cancel --job-id` against ObsessionDB now
  print the job in text mode (status, tasks completed and failed, the last error and a
  console link) instead of nothing, and wrap `--json` output in the standard
  `command`/`schemaVersion`/`ok` envelope instead of the raw console API object. A missing
  flag or an API failure now prints an error (an error envelope under `--json`) and exits
  1 instead of raising (#303).
- backfill: `chkit check` now judges a plan sent with the ObsessionDB managed `submit`
  by its job (#304). The job runs server-side and never writes a local run, so the
  check counted the saved plan as pending (`backfill_required_pending`) until the plan
  file was deleted by hand, even after the job completed. `submit` now records the job
  ID in `<meta_dir>/backfill/submissions/<plan_id>.json` (same layout as the TS CLI).
  The backfill check leaves such a plan to its job backend and counts it in a new
  `submittedCount`; a local run of the plan, once it exists, still decides its result.
  The ObsessionDB plugin's check asks the jobs API for each submitted job without a
  local run, whatever the check target: a completed job passes and its confirmation is
  saved in the submission file, so later checks skip the API call; a pending or
  running job fails with `obsessiondb_backfill_job_incomplete`, a failed or cancelled
  one with `obsessiondb_backfill_job_failed`, and a missing or expired session or an
  API error with `obsessiondb_backfill_job_unverified`. Projects without submitted
  plans make no API call. CI that runs `chkit check` needs an ObsessionDB session until
  every submitted job is confirmed completed. `sdk` exports
  `record_backfill_submission`, `list_remote_submissions` and
  `confirm_backfill_submission`.
- `clickhouse.url` with an `https://` scheme now connects over HTTPS when `secure` is
  not set (#298). Before, an unset `secure` meant plain HTTP, so
  `"url": "https://host"` connected to `http://host:8123`. The URL scheme now sets the
  protocol, as in the TS CLI, and `secure` defaults to it.
- **Behaviour change:** a `clickhouse.url` without a port now uses the scheme's default
  port, like the TS CLI: 443 for `https://`, 80 for `http://`. Before, chkit-py used
  ClickHouse's ports (8443 and 8123), so `http://host` now connects to port 80, not
  8123. Write the port in the URL (`http://localhost:8123`, `https://host:8443`) to
  connect to those ports (#298).
- **Behaviour change:** an explicit `secure` that contradicts the URL scheme
  (`secure=True` with `http://`, or `secure=False` with `https://`) is now a config
  error. Before, it overrode the scheme (#298).
- backfill: mv_replay writes each target column by name, the way ClickHouse does
  when a materialized view inserts into its `TO` table. `plan` reads the live
  target's insertable columns and each view's output columns (`DESCRIBE`), saves
  the matching list as `execution.targetColumns`, and every chunk renders it on
  both sides of `INSERT … SELECT`. A `SELECT *` view into a target with reordered
  columns or extra DEFAULT/MATERIALIZED/ALIAS columns now replays instead of failing
  with a column-count mismatch or an unknown identifier. Planning fails clearly when
  a view outputs a column the target cannot take or views feeding one target output
  different columns; `run`/`resume` refuse a plan whose target lost a planned
  column. ObsessionDB managed submit renders the same SQL (#291).
- obsessiondb: a console call for a service outside the session's active organization
  no longer fails with a bare 404 (#305). The API looks a service slug up in the active
  organization only. On a 404 for a call with a `serviceSlug` (workbench queries, job
  submit and list), `_rpc_post` reads `services.listAll` and the session, and raises
  `ServiceNotFoundError` naming the service, the active organization and the one that
  owns it (`code="service_not_in_active_organization"`), or saying no organization has
  it (`code="service_not_found"`). Both point to `chkit obsessiondb service select`.
- `--json` error envelopes now carry the raised error's stable code (#312). `migrate`,
  `snapshot` and the ObsessionDB `backfill status|cancel` commands reported
  `"code": "error"` for any error other than a `MigrateError`, so a
  `ServiceNotFoundError` lost its `service_not_in_active_organization` /
  `service_not_found` code. Like the TS CLI, any error with a string `code` attribute
  now reports that code (`chkit.cli.json_output.json_error_code`); other errors still
  report `"error"`.
- backfill: resume reads chunk status on every replica of a multi-replica target
  (#289). `sync_progress` read only the local `system.processes` /
  `system.query_log`, even with `clickhouse.cluster` set, so a chunk running or
  finished on another replica stayed pending and was submitted again. It now reads
  both through `clusterAllReplicas` when `resolve_replica_fanout` finds more than
  one replica of `clickhouse.cluster` (or `default`), and raises without submitting
  anything when a replica cannot be read. `execute_backfill` takes `cluster`.
- migrate: the DDL propagation wait checks a changed column's definition, not only
  that the column is listed (#290). After `ADD COLUMN` and `MODIFY COLUMN` it waits
  until every replica reports the same `type`, `default_kind`, `default_expression`,
  `comment` and `compression_codec`; after `MODIFY COLUMN` also until they show what
  the statement sets (default kind, the default expression formatted by the server
  with `formatQuerySingleLine`, comment, a removed default or codec).
  `RENAME COLUMN` waits until no replica lists the old name and every replica lists
  the new one. `wait_for_ddl_propagation` takes the executed `statement=`. A timeout
  names the replica and field that differ, and says when every replica kept the old
  value (ObsessionDB ignores `MODIFY COLUMN ... EPHEMERAL <default>`, #285).
- backfill: chunk INSERTs set `asterisk_include_materialized_columns=0` and
  `asterisk_include_alias_columns=0`, ahead of any `insert_settings`. A settings
  profile that enabled them made `SELECT *` return MATERIALIZED and ALIAS columns:
  copy backfills failed with a column-count mismatch, and an mv_replay of a
  `SELECT *` view could write values into the wrong target columns (#243).
- Async `migrate` statements on multi-replica targets (#246): the check for a
  still-running attempt and the status polls read `system.processes` and
  `system.query_log` on every replica, so a re-run attaches to an attempt
  running on another replica instead of resubmitting it. When a replica cannot
  be read, the check fails before any `-- before-retry:` SQL runs or the
  statement is resubmitted.
- ObsessionDB plugin: API calls now use the oRPC envelope (`{"json": ...}` in
  and out). The `{"input": ...}` body the port sent was rejected with
  `400 Input validation failed`, so no Python call reached the console API.
  The remote executor sends a submission's query id as the workbench API's
  top-level `queryId`, which the API honours; it ignored the `query_id`
  setting, so async statements ran under a random id.
- ObsessionDB plugin: console API models read the camelCase fields the API sends
  (`createdAt`, `desiredStatus`, `claimedOrganizationName`, `activeOrganizationId`, ...)
  (#288). `service list`, `service select`, `service alias set` and `service claim`
  failed with a validation error on every service, and `signup` did not see an
  existing active organization, so it created another one.
- Distributed tables (#279): `PARTITION BY`, `PRIMARY KEY` and `ORDER BY` render only
  for engines that accept them (MergeTree family, EmbeddedRocksDB, KeeperMap, S3, ...),
  so Distributed, Memory, Null, Log, Buffer and Merge tables create cleanly; `table()`
  no longer requires keys for them, and setting one fails validation with
  `engine_unsupported_clause`. `pull` writes them without keys, Distributed engine
  arguments compare equal to the quoted literals ClickHouse stores, and recreating a
  Distributed table is `risk=caution` (`danger` with `flush_on_detach = 0`). The
  ObsessionDB plugin rejects Distributed tables in `generate`, `snapshot rebuild` and
  `check` when targeting ObsessionDB, which has no shards. The README now says beta,
  matching the package classifier.
- Introspection keeps an index type or argument list it cannot express structurally
  (`sparse_grams(...)`, a bare `set`, `tokenbf_v1` with missing arguments, an unknown
  text parameter) as `SkipIndexRaw` instead of guessing: an unknown type was read as
  `set`, missing arguments as zeros (#278).
- Plans run drops of skip indexes, constraints and projections before the other ALTERs,
  so dropping a column together with an index or constraint that reads it works (#278).
- Dictionary DDL waits read `system.tables`, not each replica's in-memory
  `system.dictionaries` loader. `CREATE OR REPLACE DICTIONARY` drops the loader
  entry while a replica reloads, so `migrate` could time out after the catalog
  already had the dictionary. On several replicas the wait holds until every
  replica stores the same non-nil `uuid`. A SOURCE password is redacted to
  `[HIDDEN]` in `create_table_query`, so a password-only replace still needs
  that UUID to tell the new definition from the previous one.
- `migrate` on multi-replica targets (#265): after each DDL statement it waits until
  every replica of `clickhouse.cluster` (or `default`) shows the change, and journal
  reads keep the newest row per migration across all replicas. Single-replica and
  self-hosted targets keep the previous behavior.
- Migrations create views, materialized views, dictionaries and tables whose column
  expressions call `dictGet` after the objects they read, and drop them in reverse.
- SQL comments in view queries, `partition_by`, `ttl`, index expressions, projections,
  dictionary clauses and expression defaults are removed before whitespace is collapsed,
  so a line comment no longer swallows the rest of the statement, and drift ignores them.
- `chkit drift` compares index, TTL, key, partition and projection expressions in
  ClickHouse's canonical form (`cityHash64(a,b)` vs `cityHash64(a, b)`,
  `INTERVAL 5 YEAR` vs `toIntervalYear(5)`), falling back to string comparison.
- `chkit pull` keeps projections and key clauses intact when a backtick-quoted column
  name contains a paren or comma, and no longer emits ObsessionDB's `metadata_*` tables.
- `migrate --apply` refuses pending files with no executable statements; statements made
  only of comments are dropped. Async statements no longer pick up an earlier attempt's
  query-log entry.
- Reading a conflicted `snapshot.json` names the conflict markers, and a schema file that
  fails to load names the file, the position and any conflict markers.
- The journal never builds on a row version older than its own last write, so a read
  that lands on a lagging replica can no longer mark a migration completed with a
  statement still recorded as `started`.
- Preserve quoted clause names, delimiters, whitespace, and escaped trailing
  backslashes in table introspection and migration statement splitting.
- Escape backslashes in string defaults: `C:\temp` renders as `DEFAULT 'C:\\temp'`.
- `pull` writes introspected defaults as `fn:` expressions.
- `generate` prints validation issues as `- [code] message` lines and exits 1
  instead of raising a traceback.
- Validation flags column kinds ClickHouse cannot honor: plain-string `MATERIALIZED`
  or `ALIAS` defaults, `ALIAS`/`EPHEMERAL` columns named in keys, `partition_by` or
  engine arguments, `EPHEMERAL` columns in skip indexes or projections, and codecs on
  `ALIAS` or bare `EPHEMERAL` columns. Removing a default while changing the type runs
  `REMOVE` first as its own operation.

## 0.2.0 — 2026-08-10

**Full parity with the TypeScript chkit.** Every remaining gap is closed;
the parity decision log lives in `DRIFT.md`.

### Added
- **Dictionary primitive** — `dictionary()` DSL, validation (8 codes),
  `CREATE / CREATE OR REPLACE / RENAME / DROP DICTIONARY` planning with
  `[HIDDEN]`-password handling, `--rename-dictionary`, create-dictionary
  parser, pull introspection + rendering, codegen Pydantic models, drift
  and safety-marker coverage.
- **Phase-2 backfill engine** — chunking planner (partition slices, byte
  budgets, all split strategies), chunk-execution SQL builder with MV
  replay (every feeding MV via `UNION ALL`, chunks sized from the MV
  source), async submit/poll execution loop with atomic checkpointing,
  real `plan` / `run` / `resume` / `doctor` commands, managed
  `backfill submit` to ObsessionDB jobs with console deep-links, and the
  `on_check` findings (`backfill_required_pending`, ...).
- **Index-only projections** (`{"index": ..., "type": ...}`) and
  **function expressions in `primaryKey`/`orderBy`**.
- **CLI**: top-level `chkit codegen` and `chkit obsessiondb <cmd>`
  shortcuts; `chkit plugin <name> <cmd>` now forwards the command's own
  `--flags`.
- **Config**: function-style configs — `define_config(lambda env: ...)`
  with `ChxConfigEnv(command, mode)`; `check.failOnExtraObjects`;
  per-table `plugins` field on `table()`.

### Fixed
- Wheel now packages `chkit_plugin_codegen` and `chkit_plugin_backfill`
  (previously missing from `pip install chkit-py`).
- `ClickHouseClient.submit()` crashed on every live call (unsupported
  `query_id=` kwarg) — affected `migrate --apply` async statements.
- Snapshots serialize with `exclude_none`, matching TS `JSON.stringify`
  key omission so TS tooling reads Python-written snapshots correctly.
- JS-fidelity fixes across ports: `Number()`/`String()` semantics for
  chunk boundaries, `Date.parse` sub-millisecond truncation, WHATWG
  `URL.origin` environment fingerprints (TS-written plans now run under
  Python), JS `\s` whitespace class in key-clause comparison, `??` vs
  truthiness in drift primary-key fallback.
- Plugin command `--json` output prints real JSON (was Python dict repr).
- Table-clause parsing no longer swallows clauses when a projection's
  SELECT contains `ORDER BY`, and a primary key derived from `ORDER BY`
  no longer reads as drift.

## 0.1.4 — 2026-06-05

Documentation refresh — no code changes.

### Added
- `PARITY.md` — TypeScript ↔ Python parity matrix listing every TS module /
  command / flag, what's 1:1 today, what's intentionally deferred, and the
  rationale behind each deferral. Lives at the repo root so contributors can
  pick a deferred item and port it without spelunking through the TS source.

### Changed
- `README.md` rewritten:
  - Drops the "port-in-progress" note (the first base is done).
  - Adds an explicit TypeScript-parity section summarising what's covered.
  - Adds a Quickstart that walks through `init` → `generate` → `migrate --apply`
    → `status` / `check` / `drift`.
  - Points contributors at `PARITY.md` for the full divergence matrix.

## 0.1.3 — 2026-06-05

Major **TS parity** release. The CLI now matches the TypeScript reference 1:1
across `generate`, `migrate`, `status`, `check`, and `drift`.

### Added
- **Migration SQL artifact format** matches `packages/codegen/src/index.ts`:
  - Header comments: `chkit-migration-format: v1`, `generated-at`,
    `cli-version`, `definition-count`, `operation-count`,
    `rename-suggestion-count`, `risk-summary`.
  - Per-operation comments: `-- operation: <type> key=<key> risk=<risk>`.
  - Rename hint comments: `-- rename-suggestion: ...`.
  - Filename: `<timestamp>_<safe_name>.sql` with `_001`, `_002`, ... suffix on
    collision (matches TS `safeName` + `collisionIndex` behaviour).
- **`chkit generate --name <name>`** replaces the old `--label`. Adds
  `--migration-id <id>` (override timestamp prefix) and `--dryrun` (print plan
  without writing artifacts), matching the TS flag set verbatim.
- **`chkit migrate`** defaults to **plan/preview** like TS. Use `--apply` (or
  alias `--execute`) to actually run statements. Added `--allow-destructive`
  for migrations whose plan contains `risk=danger` operations (exit code 3
  when blocked, mirroring TS).
- **ClickHouse-backed journal**: applied migrations are recorded in a
  `_chkit_migrations` table in the target database, schema identical to
  `packages/cli/src/runtime/journal-store.ts`
  (`ReplacingMergeTree(applied_at) ORDER BY (name)`). Both TS and Python now
  share the same journal table. Override the name via
  `CHKIT_JOURNAL_TABLE`.
- **Checksum mismatch detection** in `status`, `check`, and `migrate`:
  re-hashes each `.sql` file and compares against the checksum recorded in
  the journal. Mismatches block applies.
- **`chkit check --strict`** flag matches TS: enables every policy
  (`failOnPending`, `failOnChecksumMismatch`, `failOnDrift`) regardless of
  config. Exit code 1 when any policy fails.
- **`safe_name`, `safe_migration_id`, `checksum_sql`** public helpers in
  `chkit.cli.migration_store`.

### Changed
- **Snapshot file** ends with a trailing newline (`json + "\n"`), matching
  the TS write.
- **`status` output text** matches TS verbatim:
  ```
  Migrations directory: <dir>
  Total migrations:     <N>
  Applied:              <N>
  Pending:              <N>
  ```
  Database-missing warning ("Database X does not exist on the target server")
  reproduced verbatim.
- **`pending_migrations`** and the journal now key by filename (with `.sql`),
  matching the TS `MigrationJournalEntry.name`. Pre-0.1.3 keys (stem-only)
  in `meta/applied.json` are no longer compatible; if you had an offline
  `applied.json`, either delete it or re-apply via `chkit migrate --apply`
  to populate the new ClickHouse journal.
- **`chkit init`** template prompts users to run `chkit generate --name init`
  followed by `chkit migrate --apply` (was `--label init` + `migrate`).

### Migration note for 0.1.0 / 0.1.1 / 0.1.2 users
The journal moved from `meta/applied.json` to the ClickHouse `_chkit_migrations`
table. To migrate an existing project:

1. Run `chkit migrate --apply`. Already-applied migrations will fail with
   "table already exists"; the journal will not record them.
2. Recommended: clear the old `applied.json` once the ClickHouse journal is
   the source of truth.

If you need to manually seed the journal from a `applied.json`, insert rows
into `_chkit_migrations` matching the schema in
`packages/cli/src/runtime/journal-store.ts`.

## 0.1.2 — 2026-06-05

### Fixed
- `chkit init` is now a 1:1 port of the TypeScript `init` command:
  - Writes `clickhouse.config.py` (matching the TS `clickhouse.config.ts`
    convention) instead of `chkit.config.py`.
  - Scaffolds the schema at `src/db/schema/example.py` (was `schema/events.py`).
  - The generated config exports `migrationsDir`, `metaDir`, and a `plugins`
    list explicitly, mirroring the TS template.
  - ClickHouse credentials default through `os.environ.get(...)` instead of
    being hardcoded.
  - Example schema columns match TS (`id` / `source` / `ingested_at` with
    `partitionBy: toYYYYMM(ingested_at)`).
  - Prints the same "Next steps" message + docs link as TS.
  - Removed the `--out` flag; init scaffolds into the current working
    directory like the TS version.
- `ChxUserConfig` now accepts a `plugins` list (was silently rejected as an
  extra field, which broke `chkit generate` for any config produced by
  `chkit init`).
- `define_config()` now accepts plain dicts in addition to `ChxUserConfig`
  instances, matching the TS `defineConfig` identity-helper signature.

### Changed
- All CLI help strings now reference `clickhouse.config.py` (e.g. the
  `--config` option in `generate`, `migrate`, `status`, `check`, `drift`).
- `load_config()` default path is now `./clickhouse.config.py` (was
  `./chkit.config.py`). Pass `--config <path>` to override.

### Migration note for 0.1.0/0.1.1 users
If you have an existing `chkit.config.py`, rename it to `clickhouse.config.py`
or pass `--config chkit.config.py` to each command. The file contents do not
need to change.

## 0.1.1 — 2026-06-05

### Fixed
- `chkit check` reported every migration on disk as pending, regardless of
  the applied journal (`meta/applied.json`). It now correctly subtracts
  applied ids, matching the behaviour of `chkit status` and `chkit drift`.

### Changed
- `chkit generate` no longer writes a per-migration JSON sidecar
  (`<id>.json`) next to the `.sql` file. The TypeScript reference only emits
  `.sql`; checksums are computed on the fly when needed. **If you have
  pre-0.1.1 projects with sidecars, you can safely delete the `.json` files
  in `chkit/migrations/`** — they were redundant and never read.
- `chkit.cli.migration_store` now exposes shared helpers
  (`read_applied`, `write_applied`, `pending_migrations`, `checksum_sql`).
  The duplicated private copies in the `status`, `check`, and `migrate`
  commands were collapsed into the single source of truth.

### Added
- Regression test suite at `tests/test_migration_store.py` covering the
  `check` bug above and the helper contract.

## 0.1.0 — 2026-06-04

- Initial release. 1:1 Python port of the TypeScript chkit core: schema DSL,
  canonicalization, codec parser, migration planner, validation, CLI
  (`init`, `generate`, `migrate`, `status`, `check`, `drift`).
- 255 ported tests from the TS suite + 7 originals all green.
