# Changelog

## Unreleased

### Changed
- `migrate --apply` runs the same statements as TS (#486): `--` comments are stripped and
  each statement keeps its `;`, so `on_before_apply` plugins and the failed-statement
  message see the SQL without the migration's header and marker comments.

### Fixed
- Validation rejects empty names and names with a control character (`invalid_identifier`),
  as in TS (#490). This covers database, object, column, index, constraint, projection,
  attribute and materialized view target names.
- A table or dictionary rename into another database quotes that database in its
  `CREATE DATABASE` statement (#490). A name such as `repro-old` no longer fails with a
  syntax error.
- `drift`, `check` and `pull` no longer skip tables such as `xchkit_events` (#490). They
  skip only names that start with `_chkit_`. `drift` lists such a table as an extra
  object, and `check` counts it. `pull` with no `--database` finds a database that holds
  only such tables.
- `migrate` no longer splits a statement at a `;` inside a `$$ … $$` heredoc, and a quote
  or `$` inside a `//` or `#` comment no longer changes where statements end.

## 0.3.0 — 2026-11-06

**`pull` writes SQL column defaults correctly:** 0.2.0 wrote them as plain strings
(`default="'standard'"`, `default="now()"`), which `generate` rendered as
`DEFAULT '''standard'''` and `DEFAULT 'now()'`.

- Action: re-run `chkit pull` for schemas pulled with 0.2.0, then `chkit generate`. Fix the
  `DEFAULT` lines in any migration generated from a 0.2.0 pull that is not applied yet.

### Added
- `generate` and `check` warn when a plain string default is written as a quoted SQL
  literal, such as `default="'standard'"`, which stores the quotes in the value, as in TS.
  0.2.0's `pull` wrote column defaults as plain SQL strings, so recheck schemas pulled with it.
- The user profile config is applied, as in TS (#372): when
  `$XDG_CONFIG_HOME/chkit/config.py` (default `~/.config/chkit/config.py`) exists, its
  `config` is layered under the project's `clickhouse.config.py` for every command, with
  the TS merge rules: project values win, `clickhouse`, `check` and `safety` merge per key,
  and profile plugins are added unless the project registers one with the same name. The
  profile may leave out `schema`. A profile that fails to load fails the command.
- As in TS, ObsessionDB credentials stand in for a missing profile (#375): after
  `chkit obsessiondb login`, chkit-py adds `obsessiondb()` under the project config, and
  `query`, `plugin` and `obsessiondb` run without a project config. **Behaviour change:**
  on a logged-in machine, a project that does not register `obsessiondb()` now uses the
  ObsessionDB plugin and its selected service.
- `--service <name>` on `generate`, `migrate`, `status`, `drift`, `check`, `query` and
  `pull` overrides the selected ObsessionDB service for one command, as in TS (#357). The
  name is looked up among the services the login can see, then the saved aliases; an
  unknown name fails with exit 1 and lists both. `drift` uses it with `--live`. A plugin
  `get_context` failure now prints its message (and the `--json` error envelope) instead
  of a traceback.
- `chkit migrate --setting <name=value>` (optional, repeatable, or comma-separated) sends
  ClickHouse query settings with every statement a migration runs (#321): synchronous
  statements, `mode=async` submissions, `mode=barrier` reads and `-- before-retry:` SQL,
  e.g. `--setting max_table_size_to_drop=0` to drop a table larger than the server's size
  limit. Without it no settings are sent; journal and polling queries never get them.
  `ClickHouseClient.execute()`/`submit()` and the ObsessionDB remote client take optional
  settings.
- `chkit generate --cutover <db.table>=<key>[,<key>]` (repeatable) plans a zero-downtime
  cutover of a structural change (engine, ORDER BY, PRIMARY KEY, PARTITION BY) instead of
  DROP + CREATE (#202): a shadow table, a key-based copy and verification, then a guarded
  `EXCHANGE TABLES`. `--cutover-copy backfill` leaves the copy to `chkit plugin backfill`,
  and `--cutover-old keep|drop` keeps the old table as `<table>_previous` (dropped later
  with `--drop-retained <db.table>`) or drops it.
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
  drift reports `constraint_mismatch` with `constraintDiffs`.
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

### Changed
- Column codecs follow ClickHouse's rules and stored forms, as in TS (#465). **After
  upgrading, `generate` plans a codec change for every `Delta` or `Gorilla` column written
  without `size`.** chkit-py rendered a bare `Delta` as `Delta(1)` and a bare `Gorilla` as
  `Gorilla(1)` and stored `size: 1` in the snapshot; one byte is the wrong width for anything
  but 8-bit columns (on 5M rows, `Delta(1), ZSTD(1)` compressed a `UInt64` column 2.42×
  against 4.77× for `Delta(8)`, and `Gorilla(1)` made a `Float64` column larger: 0.88×
  against 8.52×). They now render bare and ClickHouse fills in the value width, so the next
  `generate` plans one `MODIFY COLUMN ... CODEC(...)` per such column, and `drift` reports the
  column until that migration runs. It runs no mutation: only parts written after it use the
  new codec. A column whose schema sets `size=1` is unchanged.
- Removing a codec while changing the type, default or comment emits `REMOVE CODEC` as its
  own operation before the `MODIFY COLUMN`, which kept the old codec.
- A malformed codec atom (unknown or lowercase `kind`, a float level, `Delta` size 3, an
  unknown field) no longer fails the schema load with a pydantic `ValidationError`:
  `generate` reports it with the issue code and message chkit (TS) gives. New codes:
  `codec_unknown`, `codec_parameter_invalid`, `codec_none_combined`,
  `codec_chain_encryption_not_last`, `codec_chain_no_compression` (a chain of only
  `Delta`/`GCD`, before `codec_chain_must_end_with_general`), `codec_chain_float_order` and
  `codec_type_unsupported`. `ALP` is no longer a general codec, so `[ALP, ZSTD]` is
  accepted.
- New typed forms: `{"kind": "Default"}`, `ZSTD` `windowLog`, `T64` `mode`, and `FPC` with
  optional `level` and `floatSize`. `DoubleDelta` renders an explicit size; ClickHouse retains it only in verbatim chains.
- `generate`, `drift` and `pull` compare codecs in the form ClickHouse stores, so respellings
  plan nothing and a live change of the `ZSTD` window drifts. `pull` writes stored codecs as
  typed atoms (`FPC(12)` as `{"kind": "FPC", "level": 12}`, `DoubleDelta` with its size when the server retains it).
- `generate` warns about each operation that sets the experimental `ALP` codec.

### Fixed
- `pull` no longer writes the first column as the primary key or `ORDER BY` of a table that
  does not declare one, so `drift` is clean right after `pull` (#487).
- Plugin hooks run as in TS (#488): `status`, `check`, `drift` and `query` give them every
  flag that was passed, `generate` and `snapshot rebuild` run `on_init` and `get_context` (so
  they show the ObsessionDB service banner), and `pull` runs `on_config_loaded`.
- `pull` then `generate` plans nothing, and `drift` reports nothing, on a database chkit
  migrated (#466, fixed in TS too). `pull` keeps every setting the server stores, including
  `index_granularity`, and leaves out chkit's migration journal and the hidden
  `auto_minmax_index_*` skip indexes. A MergeTree table without `index_granularity` is treated
  as having the server's default, so new `CREATE TABLE` statements write it: 8192, or the new
  `clickhouse` config value `indexGranularity` for a server with another
  `<merge_tree><index_granularity>`. `drift`, `check`, `migrate` and `pull` stop when the
  server's default differs from it. Setting values and literal column defaults compare by
  value, exactly (`2.0` and `2.`, `true` and `1`, `"it's"` and `'it\'s'`, `1e21` and
  `1e+21`), in `generate` and `drift`; a string escape chkit does not know for certain
  compares as text. Column types compare in the spacing ClickHouse stores (`Decimal(10,2)`
  and `Decimal(10, 2)`). A float default or setting renders as TS writes it (`0.00001`, not
  `1e-05`). A change to a setting ClickHouse cannot alter on an existing table plans
  `DROP TABLE` and `CREATE TABLE` instead of an `ALTER` the server rejects, and `--cutover`
  supports it; its first statement checks that the table stores the read-only settings the
  migration expects. `pull` comments the settings that cannot change. On an ObsessionDB host the ObsessionDB plugin
  treats a table without `storage_policy` as `'s3'`, in the schema and, through a new
  `on_snapshot_loaded` plugin hook, the snapshot, and `generate` rejects a change to it. A
  dictionary `lifetime` compares in the form ClickHouse stores.
- Comments work end to end, as in TS (#464). Comments escape backslashes, so ClickHouse
  stores the exact text (a trailing `\` no longer breaks the statement), and an empty
  comment is the same as none. A table, view, materialized view or dictionary comment change
  plans `ALTER TABLE ... MODIFY COMMENT` (no drop and recreate, no `CREATE OR REPLACE
  DICTIONARY`); a column comment change alone is `COMMENT COLUMN`, and a removed column
  comment runs `MODIFY COLUMN ... REMOVE COMMENT`. `drift` reports a changed object comment
  as `comment_mismatch`, with both values. `pull` writes the comments of tables, views and
  materialized views from `system.tables.comment`, finds a view's `AS` and `TO` outside its
  `COMMENT`, writes non-ASCII text as is (an emoji was written as two lone surrogates), and
  skips a materialized view with an inner table, and that table, with a warning.
- **Behaviour change:** a DDL propagation wait that times out stops `migrate` with an error,
  as in TS (#464), instead of printing `⚠ DDL propagation wait failed` and recording the
  migration as applied. The wait errors use the TS names (`waitForTable: ... not yet
  visible`).
- Async `migrate` statements no longer fail on a fresh ClickHouse server that has not
  created `system.query_log` yet, as in TS.
- Concurrent `migrate --apply` runs of one migration file against other databases, or by
  projects with other journal tables in one database, no longer share async query ids
  (#463), as in TS. A run used to attach to the other run's query or read its result:
  `Applied` with no rows loaded, or the other run's failure. The id is now
  `sha256("chkit:<currentDatabase()>:<journal table>:<migration>:<statement index>")`,
  read with the server clock, and a statement the journal already tracks keeps the
  `queryId` it recorded, so an upgrade in the middle of a load still attaches to it.
- Without a `clickhouse` block or a selected ObsessionDB service, `check`, `status`,
  `migrate`, `drift`, `query` and `pull` fail with the TS message (#459), e.g. "clickhouse
  config is required for check (journal is stored in ClickHouse)", on stderr and in the
  `--json` error envelope, with exit 1. `pull` now reports it as the TS pull plugin does:
  "Pull schema failed: pull needs a target: ..." on stdout (`{"ok": false, "command":
  "schema", "error": ...}` under `--json`) and exit 2 instead of 1.
- `chkit generate --table` gives plugin hooks the same scope and plan as TS (#457):
  `on_config_loaded` and `on_schema_loaded` get the resolved `table_scope` (no matched
  tables yet, then the tables of the loaded schema) instead of a disabled one, and
  `on_plan_created` gets the full plan, with the scope filter applied after it. An
  operation a plugin adds for a table outside `--table` is now dropped, as in TS.
- `table()` defaults an omitted `primary_key` / `primaryKey` to `order_by`, as in TS (#453):
  a table with only `order_by=["id"]` gets ``PRIMARY KEY (`id`) ORDER BY (`id`)`` instead of
  raising. A sort-order engine without `order_by` still raises, now with
  "table() requires order_by/orderBy". On an engine without sort order, a table with only
  `order_by` is now reported as "sets primaryKey, orderBy ... Remove them", as in TS (it said
  "sets orderBy ... Remove it").
- `check --json` and `status --json` leave `database` out when no database is configured, as
  in TS (#452). With a plugin target (such as an ObsessionDB service) and no `clickhouse`
  block, a missing target database wrote `"database": null`; now `databaseMissing` comes
  alone.
- `chkit status --table` is accepted and ignored, as in TS and the docs (#451). Before,
  chkit-py read the snapshot and kept only the pending migrations that touch the matched
  tables, so `--table nomatch_*` reported `Pending: 0` (and `"pending": 0`,
  `"pendingMigrations": []` in `--json`) with two migrations pending. The counts and the
  pending list now always cover every migration; an invalid selector still fails, as in TS.
- Database, table, view, dictionary and materialized view names are quoted in generated SQL,
  as in TS (#448): a name that is not a plain identifier (`my-db`, `user-events`, `a.b`) is
  backtick-quoted in `CREATE`, `ALTER`, `DROP`, `RENAME`, `CREATE DATABASE`, `TO` and
  `DEPENDS ON`, and backticks and backslashes in quoted column, index, projection and
  constraint names are escaped (`` `we\`ird\\c` ``). Before, such names produced invalid SQL.
  Plain names stay bare, so SQL for existing schemas is unchanged. With `clickhouse.cluster`
  set, `ON CLUSTER` now lands after a quoted name (`` `my db`.`a b` ON CLUSTER 'c' ``) instead
  of inside it. The suggested column rename statement now uses `RENAME COLUMN IF EXISTS`, as
  in TS.
- `chkit migrate --json` prints the same JSON as TS (#460): every payload (plan, apply,
  nothing pending, `--retry`, `--abandon`, and the checksum, empty-migration and destructive
  refusals) starts with `"command": "migrate"` and `"schemaVersion": 1`, and has the
  `--table` `scope` after `mode`. **Behaviour change** for `--json` readers: each `applied`
  entry has `appliedAt` instead of `applied_at`.
- `chkit status`, `generate`, `migrate` and `check` print absolute paths, as in TS (#458):
  `status` `migrationsDir` (text and `--json`), `generate --json` `migrationFile` and
  `snapshotFile`, the `Generated empty migration: <path>` line, the `migrate --retry`
  not-found error, and the conflicted or invalid snapshot errors of `check` and `migrate`
  resolve the configured dirs against the current directory instead of printing them as
  configured. The `generate` text output now matches TS line for line (`Generated migration:
  <path>`, `Updated snapshot:`, `Definitions:`, `Operations:`, `Risk summary:`, and the `Table
  scope:` block with `--table`).
- `chkit generate --dryrun` prints the same text and JSON as TS (#461), including the
  rename suggestions with their reason and confirmation SQL, which were missing. In
  `--json`, an operation has `warning` only when it is set (no more `"warning": null`).
- `chkit check` passes the plugins' `on_check` the flags that were passed, keyed by long name
  as in TS (`--json`, `--strict`, `--table`, `--config`, `--force-shared-engines`,
  `--no-shared-engines`, `--service`) (#450). Before, `on_check` always got `{}`, so
  `check --force-shared-engines` had no effect: on a target not recognized as ObsessionDB the
  ObsessionDB plugin did not reject a `Distributed` table, and check passed where TS fails with
  `obsessiondb_distributed_unsupported`.
- `chkit generate`, `migrate` and `pull` pass every plugin hook they run the flags that were
  passed, keyed by long name as in TS (#456): `on_config_loaded`, `on_schema_loaded` and
  `on_plan_created` in generate, `on_init`, `get_context`, `on_before_apply` and
  `on_after_apply` in migrate, and `on_init`, `get_context` and `on_pull_introspect` in pull.
  Before, generate's hooks got only `--force-shared-engines` / `--no-shared-engines` (and
  `on_plan_created` got `{}`), the apply hooks and `on_pull_introspect` got `{}`, and
  `on_init` / `get_context` got only `--service`. To key them as TS does, pull's `--force`
  and `--overwrite` are now two options (either one overwrites; `-f` stays on `--force`).
- `chkit check` runs the plugins' `on_config_loaded` hooks, as in TS (#449): with command
  `check` and the resolved `--table` scope, right before `on_check`. Before, chkit-py
  never called them, so state a plugin set up there was missing in `on_check`. A hook
  error fails the check with exit 1 and `Plugin "<name>" failed in onConfigLoaded: ...`
  (plus the `--json` error envelope). A `--table` selector that matches no table still
  skips every plugin hook.
- `chkit migrate` runs the plugins' `on_config_loaded` hooks, as in TS (#455): in plan and
  apply mode (and with `--retry` / `--abandon`), with command `migrate` and the resolved
  `--table` scope, after the scope is resolved and before the migrations are listed. Before,
  chkit-py never called them. A hook error stops migrate before it reads the journal, with exit 1
  and `Plugin "<name>" failed in onConfigLoaded: ...` (plus the `--json` error envelope).
- Credentials in `clickhouse.url` (`http://user:password@host`) are used to sign in, as in TS
  (#432): each one the URL sets, percent-decoded, takes precedence over the configured
  `username` / `password`. Before, chkit-py ignored them and signed in with the configured
  ones. "Authentication failed for user ..." names the URL's user, and the invalid-URL errors
  no longer print the credentials (the protocol error prints the scheme only, as in TS).
- `chkit query` keeps numbers in `JSON`, `Object` and `Dynamic` columns as numbers, as in TS
  (#438). Every number in a column whose type is or contains one of them was a string,
  floats and small integers included: `CAST('{"a": 2.5, "b": [1, 0.1]}' AS JSON)` printed
  `{"a":"2.5","b":["1","0.1"]}`. Inside these columns a number now becomes a string of the
  digits ClickHouse sent only when a float cannot hold it: `2.5`, `1` and `0.1` stay
  numbers, `18446744073709551615` stays a string, in the table and in `--json`.
- `chkit check` prints the same JSON and text as TS and judges the same way (#435).
  **Behaviour change:** `check` no longer validates the schema files, a plugin fails it
  only with an evaluated `error` finding, `--table` scopes only the drift and plugin
  checks, and `--json` drops `issues`, `pendingMigrations`, `checksumMismatches` and
  `pluginCheckResults` (use `chkit status --json` for the migration names).
- The typed `T64` codec is accepted before a general codec, as in TS (#434). ClickHouse accepts
  `CODEC(T64, LZ4)`, `CODEC(T64, ZSTD(3))` and `CODEC(Delta, T64, LZ4)`, but chkit-py classed
  `T64` as a general codec, so those chains failed validation with
  `codec_chain_multiple_general`. `T64` compresses on its own, like `DoubleDelta`, so it moved
  from `GeneralColumnCodec` to `PreprocessingColumnCodec`: a lone `T64` still validates,
  `[{"kind": "T64"}, {"kind": "LZ4"}]` now validates and renders `CODEC(T64, LZ4)`, and `T64`
  after a general codec, which ClickHouse rejects, fails with
  `codec_chain_must_end_with_general`. A migrated `T64` chain reports no drift.
- An unhandled error prints one line and exits 1, as in TS (#437): ClickHouse's own message
  for a server error, the error's message otherwise. Before, it printed a full traceback,
  under `--json` after the error envelope too. `CHKIT_DEBUG=1` logs the traceback to stderr.
  Usage errors (exit 2), `Ctrl-C` (exit 130) and the commands' own exits are unchanged.
- `chkit generate` compares a column's type as rendered, as in TS (#433, port of #275), so
  switching between `type="Nullable(Int64)"` and `type="Int64", nullable=True` plans
  nothing. Before, it wrote a `MODIFY COLUMN` migration that changed nothing. A change to
  nullability, to the underlying type or to a nested `Nullable` wrapper (such as
  `LowCardinality(Nullable(String))`) still plans `MODIFY COLUMN`. Column rename
  suggestions and codec removals match across both spellings too.
- The typed `GCD` codec is a preprocessing codec, as in TS (#408). ClickHouse rejects a lone
  `CODEC(GCD)` because GCD does not compress, and chkit-py classed it as a general codec, so
  no typed GCD chain was valid: `[{"kind": "GCD"}, {"kind": "LZ4"}]` now validates and
  renders `CODEC(GCD, LZ4)`, and `GCD` moved from `GeneralColumnCodec` to
  `PreprocessingColumnCodec`. A chain made only of `Delta` and `GCD` steps, such as a lone
  `GCD` or `Delta`, which ClickHouse rejects for the same reason, now fails validation with
  `codec_chain_must_end_with_general` before reaching the server.
- A view or materialized view `comment` reaches ClickHouse, as in TS (#406): the generated
  `CREATE VIEW` / `CREATE MATERIALIZED VIEW` carries `COMMENT '...'` before `AS`, so
  `system.tables.comment` is set. Before, the comment was dropped, and a comment change
  recreated the view still without it.
- ClickHouse errors print ClickHouse's message, as in TS (#413): `chkit query`,
  `chkit migrate` and every `--json` error envelope drop clickhouse-connect's prefix and
  suffix, and a wrong password or an unreachable server gets a short message without the
  credentials written in the URL.
- `chkit drift` and `chkit check` compare the snapshot with the live server by default, as
  in TS (#405); `--live` is still accepted. **Behaviour change:** both now need a
  `clickhouse` block or a selected ObsessionDB service, and the offline comparison of the
  schema files with the snapshot is removed with its `--json` fields (run
  `chkit generate --dryrun` to see schema changes not written yet).
- `chkit drift --live` prints the same JSON and text as TS (#410). **Behaviour change** for
  `--json` readers: `objectDrift` entries use `expectedKind` / `actualKind`, `tableDrift`
  entries use camelCase keys, unset fields are left out instead of `null`, and
  `snapshotFile` is an absolute path.
- `chkit drift` and `chkit check --live` compare a column's type as rendered, as in TS
  (#409, port of #275), so `type="Nullable(Int64)"` and `type="Int64", nullable=True` both
  match a live `Nullable(Int64)` column. Before, a column spelled `Nullable(...)` inline
  reported `changed_column` on a table that matched. A change to nullability or to the
  underlying type still reports `changed_column`.
- `chkit drift --live` and `chkit check` compare the query of each managed view and
  materialized view, and a materialized view's `TO` target, with the live ones, as in TS
  (#382), and report `query_mismatch` or `target_mismatch`. Queries are compared after
  ClickHouse's formatter, so an unchanged view reads clean.
- `chkit drift` and `chkit check --live` compare column codecs, as in TS (#383): a codec
  added, removed or changed on the server reports `changed_column`. Codecs are compared in
  the form ClickHouse stores them, so `ZSTD` matches `ZSTD(1)`, `LZ4HC` matches `LZ4HC(0)`,
  and `DoubleDelta(4)` and `FPC(12, 8)` match the `DoubleDelta` and `FPC(12)` ClickHouse
  keeps. Introspection reads a negative codec level (`ZSTD(-1)`, stored as
  `ZSTD(18446744073709551615)`) back as negative.
- `chkit query` keeps every digit of 64-bit and wider integers and Decimals and prints the
  same output as TS, in `--json` and in the table (#381). **Behaviour change:** in `--json`,
  `UInt64`, `Int64`, 128/256-bit integer and `Decimal` values are strings (they were
  numbers), and `INSERT ... VALUES` with inline data is no longer accepted; use
  `INSERT ... SELECT`.
- chkit-py works with a read-only ClickHouse user (`readonly = 1` or `readonly = 2`, granted
  `SELECT`) for `query`, `status`, `check`, `drift`, `pull` and `migrate` without `--apply`,
  as in TS (#402): reading the journal no longer creates it. A journal created before
  per-operation tracking needs one run as a user that can `ALTER` it.
- `chkit query --json` prints ClickHouse's `JSON` format envelope plus the `query_id`, as
  in TS (#377): `meta[].type` is the ClickHouse type name (it was a Python object repr),
  values are formatted by ClickHouse (`DateTime64(3)` as `"2026-10-31 00:32:27.123"`, not
  ISO with a `T`; 64-bit and wider integers and `Decimal` as exact strings, see #381), and
  `statistics` holds ClickHouse's `elapsed`, `rows_read` and `bytes_read` numbers instead
  of the HTTP summary strings. Non-ASCII text is printed as is instead of `\u`-escaped.
- `schema` is optional in `ChxUserConfig`, as in TS (#376), so a user profile written with
  `define_config()` or `ChxUserConfig(...)` may leave it out. It failed with `Field
  required` before; only a plain dict profile could leave it out. A project config without
  `schema` resolves to no schema globs, as in TS: a command that loads schema files fails
  with `No schema files matched. Check config.schema patterns.`
- `chkit obsessiondb service alias remove` drops the `aliases` key from
  `.chkit/obsessiondb.json` when it removes the last alias, as TS does, instead of writing
  `"aliases": {}` (#372).
- ObsessionDB service aliases now live in the same file as the selected service, as in TS
  (#366): the project's `<config dir>/.chkit/obsessiondb.json`, or
  `$XDG_CONFIG_HOME/chkit/obsessiondb.json` only for a config under the user config dir.
  An alias saved by `chkit obsessiondb service alias set` in one port now resolves through
  `--service` and `alias list|remove` in the other. Aliases that older chkit-py versions
  saved in the user-global file are no longer read for a project config; set them again
  in the project. Selecting a service no longer drops the file's aliases.
- `chkit plugin backfill plan --from/--to` now windows a table partitioned on a `Date`
  column (#352). `system.parts` reports `min_time`/`max_time` as 1970-01-01 for it and
  fills `min_date`/`max_date` instead, so any `--from` selected no partition ("No
  partitions found … The table may be empty") and `--to` alone selected all of them. The
  planner now falls back to `min_date`/`max_date`, with a partition's last day ending at
  23:59:59.
- `chkit migrate --setting` rejects ClickHouse HTTP parameters with a usage error before
  anything runs (#353): `query`, `database`, `query_id`, `session_id`, `session_check`,
  `session_timeout`, `user` and `password`. They are not query settings: `database` sent
  unqualified statements, async INSERTs included, to another database while the journal
  recorded the migration as applied.
- A project whose `clickhouse.database` does not exist yet can bootstrap again (#351):
  `ClickHouseClient.connect()` no longer sends the database with clickhouse-connect's
  connect-time queries, which ClickHouse rejected with `UNKNOWN_DATABASE` (code 81).
  `status` and `check` report the missing database (`databaseMissing` and `database` in
  `--json`), `migrate` lists the pending migrations, and `migrate --apply` runs the
  migration's `CREATE DATABASE` (a statement failing with code 81 is retried without the
  database, as in TS) and journals it in the new database.
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
  ObsessionDB service too, like `check` and the TS CLI (#340), so a project with both a
  selected service and a `clickhouse` block no longer applies migrations to one target and
  reads the journal from the other.
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
- backfill: `chkit check` judges a plan sent with the ObsessionDB managed `submit` by its
  job (#304): a completed job passes, and a pending, running, failed, cancelled or
  unverifiable one fails the check, instead of the plan counting as pending until its file was deleted by
  hand. **Behaviour change:** CI that runs `chkit check` needs an ObsessionDB session until
  every submitted job is confirmed completed.
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
- backfill: mv_replay writes each target column by name, the way ClickHouse does when a
  materialized view inserts into its `TO` table (#291), so a `SELECT *` view into a target
  with reordered columns or extra DEFAULT/MATERIALIZED/ALIAS columns replays instead of
  failing. Planning fails clearly when a view's columns do not fit the target.
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
- migrate: on multi-replica targets, the DDL propagation wait after `ADD COLUMN`,
  `MODIFY COLUMN` and `RENAME COLUMN` holds until every replica shows the column's new
  definition, not only until the column is listed (#290). A timeout names the replica and
  field that differ.
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
- Distributed, Memory, Null, Log, Buffer and Merge tables create cleanly (#279):
  `PARTITION BY`, `PRIMARY KEY` and `ORDER BY` render only for engines that accept them,
  and setting one elsewhere fails with `engine_unsupported_clause`. The ObsessionDB plugin
  rejects Distributed tables when targeting ObsessionDB, which has no shards.
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
- `generate` prints validation issues as `- [code] message` lines and exits 1
  instead of raising a traceback.
- Validation flags column kinds ClickHouse cannot honor: plain-string `MATERIALIZED`
  or `ALIAS` defaults, `ALIAS`/`EPHEMERAL` columns named in keys, `partition_by` or
  engine arguments, `EPHEMERAL` columns in skip indexes or projections, and codecs on
  `ALIAS` or bare `EPHEMERAL` columns. Removing a default while changing the type runs
  `REMOVE` first as its own operation.
- `chkit query` prints `Float32`/`Float64` values as TS does, in the table and in `--json`
  (#411). It printed Python's `repr`: `1e-07`, `1e-06` and `1e-05` where TS prints `1e-7`,
  `0.000001` and `0.00001`, also inside arrays, maps and tuples (and in `statistics`), and
  the wider cell widened the table column. Values now print as JavaScript prints a number:
  the shortest digits that read back as the same double, in exponent form (`1e-7`,
  `1.5e+21`) only below `1e-6` and from `1e21`.
- Column types are trimmed as TS `String(type).trim()` trims them (#454). `to_create_sql`,
  `render_alter_add_column` and `render_alter_modify_column` rendered the type of a
  definition straight from `table()` untrimmed (`` `id`   UInt64 ``); they now emit
  `` `id` UInt64 ``. The type trim in canonicalization, the planner, cutover and drift, and
  of index projection types, used `str.strip()`, which keeps U+FEFF where TS removes it and
  removes U+001C-U+001F and U+0085 where TS keeps them; it now trims the same characters as
  TS. The new `render_column_type()` in `chkit.core.sql` is the one renderer.

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
