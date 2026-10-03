# @chkit/core

## 0.2.0-beta.9

### Patch Changes

- d072fe3: Add a typed form for SQL expression column defaults (#234): `default: { expression: 'now64(3)' }` renders `DEFAULT now64(3)`, and it works with every `defaultKind`: `{ defaultKind: 'MATERIALIZED', default: { expression: 'toDate(ts)' } }` renders `MATERIALIZED toDate(ts)`. Plain strings stay quoted literals (`default: 'pending'` renders `DEFAULT 'pending'`), and the `fn:` prefix keeps working as the legacy spelling of an expression. `snapshot.json` stores both forms as the `fn:` string, trimmed (`fn:now64(3)`), so switching between `{ expression }`, `'fn:now64(3)'` and `'fn: now64(3)'` generates no migration and snapshots stay readable by chkit-py. SQL comments in an expression default are dropped when it is rendered, so a `--` comment no longer swallows the `,`, `COMMENT`, `CODEC` or `;` after it, and `drift` and `check` now ignore every kind of comment in it, including `#`, `//` and nested `/* */` comments.

  `chkit generate` now rejects a plain string `DEFAULT` or `EPHEMERAL` default that starts with a function call on a column that cannot hold a string. For example, `default: 'now64(3)'` on a `DateTime64(3, 'UTC')` column used to generate `DEFAULT 'now64(3)'` and fail at `chkit migrate` with "default expression and column type are incompatible"; on a `Nullable` number, date, time, UUID or IP address column ClickHouse accepted it and silently stored `NULL`. The new `column_default_looks_like_expression` error names the column and the fix. Columns that hold text (`String` and its aliases, `FixedString`, `Enum`, `LowCardinality(String)`, `Dynamic`, a `Variant` with a string member) are unaffected. `column_expression_required` now also reports an `{ expression }` with no SQL or only comments, and `column_default_invalid` reports a default object without a string `expression`, an expression that keeps the `fn:` prefix, one with an unterminated string, quoted identifier, or block comment that would swallow the rest of the migration, and one with a `#` that starts no comment, which ClickHouse rejects and which at the end of an expression used to comment out the column's `COMMENT` and `CODEC` without an error. The troubleshooting guide shows how to recover a migration that already failed this way.

  `chkit pull` now writes introspected defaults as `{ expression: "..." }` next to their `defaultKind`, instead of `"fn:..."`; the pulled definitions are unchanged. Upgrade `chkit` together with `@chkit/plugin-pull`: chkit 0.2.0-beta.8 and older render the object form as `DEFAULT [object Object]`. `chkit init` scaffolds the typed form, `ColumnDefinition.default` documents both forms in its type, `renderDefault()` accepts `{ expression }`, and `@chkit/core` exports `parseColumnDefault()` for plugins that read defaults.

- 2f53550: Support `MATERIALIZED`, `ALIAS`, and `EPHEMERAL` columns with a new `defaultKind` column field. `default` holds the value or `fn:` expression for every kind, and `EPHEMERAL` may omit it. SQL rendering, `pull`, snapshots, and drift keep the kind; validation reports `column_expression_required` and `column_default_kind_invalid`.

  - `DEFAULT`/`MATERIALIZED` expression changes emit `MODIFY COLUMN` with a warning that stored values are not rewritten, and removed expressions emit `REMOVE DEFAULT`/`REMOVE MATERIALIZED`. Conversions to or from `ALIAS`/`EPHEMERAL` fail `generate` with `column_kind_change_unsupported`.
  - Codegen emits `Row` (`SELECT *`), `RowExplicit` (all readable columns), and `RowInsert` (all insertable columns) for these tables; ingest helpers take `RowInsert`.
  - Inserts into tables with `EPHEMERAL` columns name their columns: generated ingest helpers pass `columns`, which `@chkit/clickhouse` `insert()` and the ObsessionDB remote executor send, and the `@chkit/plugin-ingest` destination does the same.
  - Automatic backfills omit `MATERIALIZED` and `ALIAS` columns and check live column kinds first: a copy is blocked only when the target has both `EPHEMERAL` and `MATERIALIZED` columns, `mv_replay` by any `EPHEMERAL` column, and a missing target fails with "does not exist or is not visible yet".
  - `drift` and `check` compare defaults token by token. Write expressions in the canonical form ClickHouse stores, such as `CAST(x, 'String')`, to avoid drift.
  - Fix string defaults containing backslashes: `C:\temp` now renders as `DEFAULT 'C:\\temp'`.

- 98e3667: `MATERIALIZED` and `ALIAS` columns with a plain string default now fail validation with `column_expression_requires_fn` instead of storing the text. `ALIAS` or `EPHEMERAL` columns named directly in keys, `partitionBy` or engine arguments report `column_kind_not_stored`; `EPHEMERAL` columns in skip indexes or projections, and codecs on `ALIAS` or bare `EPHEMERAL` columns, are also rejected. Removing a column expression now runs `REMOVE` as its own operation before `MODIFY COLUMN`, so a type change whose old default cannot be cast (for example `String DEFAULT 'abc'` to `UInt64`) migrates successfully.
- 96a18c6: Recover a migration that failed part-way without editing the journal table by hand (#233). When no statement of the in-progress migration had completed or was interrupted while running, an edited file now runs again from statement 1 on the next `chkit migrate --apply`. Otherwise `chkit migrate --apply --retry <migration>` resumes with the edited file: chkit checks that every statement that completed keeps its position and `-- operation:` marker, and that statements sharing such a marker (a column's `REMOVE DEFAULT` or `REMOVE MATERIALIZED` and the `MODIFY COLUMN` after it) all stay in the file, records the new checksum, and continues from the first statement that did not complete. For any other migration `--retry` has no effect and the output says so, also when nothing is pending, so pipelines can pass it to every environment. `chkit migrate --abandon <migration>` shows what it would reset and, with `--apply`, writes a new journal version in which every recorded statement failed, so the next apply runs the file from statement 1; it lists the statements that stay applied in ClickHouse, runs no migration SQL (its only write is a journal INSERT), and needs neither the migration file nor a readable `snapshot.json`. The refusal for an edited in-progress migration names both commands, and these errors carry stable `--json` error codes. An async statement now only trusts `system.query_log` entries of queries that started after it was submitted, so a load that an earlier attempt finished is no longer reported as finished when the edited statement fails before it starts; such a failure is recorded as failed. A re-run that attaches to a still-running attempt likewise only trusts entries of queries that started no earlier than that attempt, so it no longer records an earlier attempt's result for it. The ObsessionDB remote executor now compares these bounds with the query's start time, as a direct connection does: its status checks failed with `TYPE_MISMATCH` on such a bound, so a retried async statement was never journaled as completed and each re-run loaded its data again. It also reports how long a running query has run, which an attach needs for its bound. In `--json` mode, async progress lines go to stderr instead of stdout. `chkit migrate --apply` refuses to apply a pending migration file without executable statements, such as a `generate --empty` stub without SQL, instead of recording it as applied; plan mode lists these files. In `@chkit/core`, `extractExecutableStatements` no longer returns a statement made only of comments, which ClickHouse rejects as `Empty query` (for example a block comment after the last statement).
- 46cbf88: Order migration DDL by object dependencies (#231). `chkit generate` sorted creates by kind and then by name, so a migration that recreated stacked views could fail halfway with `Unknown table expression identifier` after its drops had already run. An object is now created after every object it reads and dropped before them. This covers a view that reads another view, a materialized view, a dictionary (`dictGet`, `dictionary()`), or a Join table (`joinGet`), named by a string or an identifier; a created or dropped table whose column `DEFAULT`, `MATERIALIZED`, `ALIAS`, or `EPHEMERAL` expression calls `dictGet`; a materialized view's `TO` table and `DEPENDS ON` views; and a dictionary's ClickHouse `TABLE`/`QUERY` source. References come from qualified `database.name` names and from unqualified `FROM`/`JOIN` targets and name arguments, which resolve against the object's own database. Objects with no dependency inside the migration keep the kind-then-name order; refreshable materialized views are no longer ordered by `DEPENDS ON` targets outside the migration. `ALTER` statements are not reordered, so adding or changing a column whose expression calls `dictGet` on a dictionary created in the same migration, or dropping a dictionary together with the column expression that calls it, still takes two migrations. Renames (`--rename-table`, `--rename-column`, `--rename-dictionary`, or `renamedFrom`) no longer re-sort the plan by name, which used to undo the `DEPENDS ON` order of refreshable materialized views.
- b59fc83: Quote and escape identifiers in generated SQL. Database and object names that are not plain identifiers (e.g. containing `.`, `-` or spaces) are now backtick-quoted, and backticks or backslashes inside any column, index, projection, attribute or object name are escaped. Plain names render exactly as before. `ON CLUSTER` injection understands quoted object references, and validation rejects empty names and names containing control characters (`invalid_identifier`).

  Names that need quoting now also round-trip through introspection and drift: key entries that name a declared column are never split on commas, the `CREATE TABLE` parser ignores parens and commas inside quoted names and unescapes projection names, and drift compares key clauses by their unescaped identifiers.

- c49f0a9: Add `chkit snapshot rebuild` to repair `snapshot.json` when two branches conflict on it (#235). Every `chkit generate` rewrites the whole snapshot, so two branches that each generated a migration always conflicted on it, and taking either side of the conflict dropped the other branch's entries. `snapshot rebuild` rewrites the snapshot from the schema definitions with the same plugin hooks, validation, and writer as `generate`. It never writes a migration, tolerates a snapshot with conflict markers or invalid JSON, lists the entries it added, removed, or changed, leaves an up-to-date snapshot untouched, and supports `--dryrun` and `--json`. After a conflict it prints the `git diff` commands to compare the result with both sides: `HEAD`, and `MERGE_HEAD` during a merge or `REBASE_HEAD` during a rebase. Commands that read a snapshot with unresolved conflict markers now say so and point to `chkit snapshot rebuild`, and the error for other invalid snapshot JSON no longer suggests deleting the file.

  Under Bun, a schema file that did not load, such as one that still had conflict markers during a rebase, could make `generate` and other commands exit 0 with no output. They now exit 1. Under Bun and Node, the error names the schema file that failed to load and says when conflict markers caused it, including markers in a module the file imports. Commands that do not use the schema no longer import it unless `--table` is set.

  `@chkit/codegen` exports `writeSnapshot` and `serializeSnapshot`, and `@chkit/core` exports `definitionKey` and `hasConflictMarkers`.

- 672d67e: Remove SQL comments from schema SQL fragments before writing them on one line (#232). A `--`, `//` or `#` comment in a view or materialized view `as`, `partitionBy`, `ttl`, a skip index expression, a projection, or a dictionary `source`/`layout`/`lifetime` lost the newline that ended it, so it swallowed the rest of the fragment, and a trailing one swallowed the statement's `;`: `chkit generate` accepted the schema, then `chkit migrate` failed with a syntax error after earlier statements had run, or created a truncated view. Comments now follow ClickHouse's syntax (`--`, `//`, `#!`, `# ` and nested `/* */`), and comment markers inside string literals and quoted identifiers are kept. Full-text (`type: 'text'`) index expressions keep their own parser, which only drops `--` and non-nested `/* */` comments. Fragments without comments normalize exactly as before, so existing snapshots plan nothing new, except an object whose snapshot already holds SQL cut short by a comment: the next `chkit generate` recreates it in full. A `ttl` or `partitionBy` that holds only comments counts as no clause, so removing a TTL that way renders `REMOVE TTL` instead of an invalid `MODIFY TTL ;`. `chkit drift` no longer reports comments in TTL, partition, skip index or projection SQL as drift, and still compares literal defaults such as `'http://x'` as values. `mv_replay` backfills of a materialized view with commented SQL replay the full query. `normalizeSQLFragment` from `@chkit/core` now removes comments; pass it SQL only. Upgrade every chkit install in a team together: snapshots written by this version hold SQL without comments, so an older chkit plans to recreate or alter every object whose definition carries a comment.

## 0.2.0-beta.8

### Minor Changes

- fedbf56: Support Kafka engine tables without MergeTree key clauses, with escaped literal
  settings, pull round trips, and normalized drift/check comparisons. Preserve the
  existing setting-string contract for other engines. Reject unsupported Kafka
  changes before writing migration artifacts and document an explicit, destructive-
  gated replacement workflow. Handle quoted delimiters and escaped trailing
  backslashes in introspection and migration statement splitting.
- 256ec62: Support ClickHouse `text` indexes in schemas, migrations, pull, and drift. Text
  indexes require a tokenizer and support preprocessing, postprocessing, phrase
  search, and dictionary/posting-list options when supported by the server.
  Granularity is automatic. Preserve whitespace and escapes inside SQL literals,
  compare parameter order and SQL formatting consistently, and reject unsupported
  or malformed metadata instead of silently losing settings. Includes Python parity
  and live adversarial round-trip tests on ClickHouse 26.3 and 26.8.

### Patch Changes

- 65c90d6: Add `dictionary()` as a first-class ClickHouse schema primitive, mirroring `materializedView()` across the full lifecycle: DSL authoring, validation, canonicalization, SQL rendering, migration planning/diff, drift, `check`, destructive-op safety, `pull` introspection, and `codegen` typed interfaces.

  - `dictionary({ database, name, attributes, primaryKey, source, layout, lifetime, range?, settings?, comment? })` — attributes support `default`/`expression` (mutually exclusive), `hierarchical`, `bidirectional` (requires `hierarchical`), `injective`, and `isObjectId`. `range: { min, max }` renders `RANGE(MIN ... MAX ...)` for `RANGE_HASHED`/`COMPLEX_KEY_RANGE_HASHED` layouts, and `settings` renders `SETTINGS(...)`.
  - ClickHouse has no `ALTER DICTIONARY`, so any structural change plans a single atomic `CREATE OR REPLACE DICTIONARY`. Dropping a dictionary is treated as destructive and blocked without `--allow-destructive`.
  - Set `renamedFrom` on a dictionary (or pass `--rename-dictionary old_db.old=new_db.new` to `chkit generate`) to rename a dictionary via `RENAME DICTIONARY IF EXISTS ... TO ...` instead of a destructive drop + create.
  - `chkit pull` introspects live dictionaries (including `RANGE`/`SETTINGS` and all attribute modifiers) into typed schema files, preserving ClickHouse's `[HIDDEN]` password redaction on `SOURCE(...)` credentials. A `SOURCE(...)` password change diffs and migrates like any other field change; `chkit generate` warns when a literal password is about to be written into migration SQL as plain text. `chkit pull` warns in two cases: when an introspected password comes back as `[HIDDEN]` (chkit can't recover the real value, so that dictionary's `source` is excluded from future diffs until it's replaced), and when ClickHouse is configured to reveal real passwords on introspection (`display_secrets_in_show_and_select` + `displaySecretsInShowAndSelect`), since that writes a plain-text credential into the generated schema file with no other indication. All warnings print to the console and are included as a `warnings` array in `--json` output.
  - `codegen` generates a typed interface (and optional Zod schema) for each dictionary from its `attributes`, always included regardless of `includeViews`.
  - `ON CLUSTER` mode stamps `ON CLUSTER <name>` onto every dictionary DDL statement, including `CREATE OR REPLACE DICTIONARY` and `RENAME DICTIONARY`.

- 3f1db03: Support index-only projections (`PROJECTION p INDEX (a, b) TYPE basic`) end to end. `ProjectionDefinition` is now a union of the existing `{ name, query }` SELECT form and a new `{ name, index, type }` index-only form, which renders without the wrapping parens that made the SELECT form invalid for it. `chkit pull` previously parsed only the SELECT form and dropped index-only projections on the floor, so a pulled schema silently recreated the table without them; they now round-trip through pull, generate, migrate, and drift.

  Index expressions are normalized to the exact form ClickHouse stores — a single expression bare (`INDEX a`), several as a tuple (`INDEX (a, b)`), redundant parens peeled at every level, and a space after each argument separator — so `'(a)'` and `'a'`, or `'concat(x,y)'` and `'concat(x, y)'`, describe the same table and no longer read as drift.

  Two new validation errors guard the new form: `projection_ambiguous_kind` when an entry sets both `query` and `index` (which would otherwise silently discard the SELECT body), and `projection_empty_index` when the index expression is empty (which would otherwise emit invalid DDL).

- f8238db: Add `@chkit/plugin-ingest`, the first cut of scheduled pull ingestion into ClickHouse. Streams are ordinary TypeScript: a `read` async generator fetches, maps, and yields destination-shaped rows, and `definePipeline` returns a tagged, non-durable group of streams; only pipelines exported from the project entry participate, with no global registry. `chkit ingest run` executes the selected streams (`--tag` is repeatable with exact AND semantics; an explicit empty selection fails), `chkit ingest list` shows the loaded graph, and `chkit ingest status` prints committed checkpoints.

  Progress follows one rule: rows are saved before the bookmark advances. Every batch is written with a stable `insert_deduplication_token`, and only after the ClickHouse acknowledgement does the executor append a `batch_committed` fact to the append-only ingestion journal. Checkpoints are a projection of that journal, so a crashed or lost-acknowledgement run replays from the last durable boundary with the same batch identity instead of skipping rows. Bundled strategies are `timestampWindow({ start, overlapMs })` (with a custom `from` callback alternative), `cursorState` for provider-owned state, and the full-sync fallback; `--backfill <id>` runs an explicit range in an isolated checkpoint namespace.

  `rawTable` and `rawRows` land provider objects untouched in a native `JSON` column, so typed shapes are derived inside ClickHouse with ordinary views or materialized views instead of being mapped in pipeline code.

  `FetchContext` exposes source request and cancellation capabilities independently of checkpoint types; `ReadContext` extends it.

  Source operations run through `context.attempt`, which owns fetch permits, p-retry-shaped retry policy, `Retry-After`, cancellation, and failure classification (`HttpError.fromResponse` is the canonical boundary for fetch-based readers). Pipelines carry separate `maxStreams`, `maxFetches`, and `maxLoads` ceilings, executions have a duration budget, and the executor emits OpenTelemetry spans.

  `@chkit/core` gains a singular `entry` config field, mutually exclusive with `schema` globs: the module is imported once, its exported schema definitions are collected, and exported plugin-domain definitions are collected by their plugins. `@chkit/clickhouse` `insert()` accepts per-insert `settings`.

  Successful syncs rotate batch identity using the existing journal, while failed runs retain their replay identity. Execution cancellation also bounds journal I/O, stalled writes cannot report success, and loader construction failures release their permits. Ingestion requires a direct ClickHouse connection; incompatible host executors fail before any writes. Project `entry` and `schema` settings replace the inherited source mode when layering configuration.

- 5a8d805: Support ClickHouse function expressions in `primaryKey`/`orderBy` (e.g. `toDate(ts)`, `toStartOfHour(session_end)`). Validation no longer reports `primary_key_missing_column`/`order_by_missing_column` for expression entries, and generated DDL emits them verbatim instead of quoting the whole expression as a column name. Plain column references are still validated and backtick-quoted as before.

  Migration planning now compares key clauses independent of insignificant whitespace and identifier backtick-quoting, so an expression written as `toStartOfHour( ts )` or a column written bare as `user-id` no longer diffs against ClickHouse's normalized `toStartOfHour(ts)` / `` `user-id` `` and triggers a phantom table recreate on `migrate`/`drift`/`check`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.

## 0.1.2-beta.7

### Patch Changes

- 65c90d6: Add `dictionary()` as a first-class ClickHouse schema primitive, mirroring `materializedView()` across the full lifecycle: DSL authoring, validation, canonicalization, SQL rendering, migration planning/diff, drift, `check`, destructive-op safety, `pull` introspection, and `codegen` typed interfaces.

  - `dictionary({ database, name, attributes, primaryKey, source, layout, lifetime, range?, settings?, comment? })` — attributes support `default`/`expression` (mutually exclusive), `hierarchical`, `bidirectional` (requires `hierarchical`), `injective`, and `isObjectId`. `range: { min, max }` renders `RANGE(MIN ... MAX ...)` for `RANGE_HASHED`/`COMPLEX_KEY_RANGE_HASHED` layouts, and `settings` renders `SETTINGS(...)`.
  - ClickHouse has no `ALTER DICTIONARY`, so any structural change plans a single atomic `CREATE OR REPLACE DICTIONARY`. Dropping a dictionary is treated as destructive and blocked without `--allow-destructive`.
  - Set `renamedFrom` on a dictionary (or pass `--rename-dictionary old_db.old=new_db.new` to `chkit generate`) to rename a dictionary via `RENAME DICTIONARY IF EXISTS ... TO ...` instead of a destructive drop + create.
  - `chkit pull` introspects live dictionaries (including `RANGE`/`SETTINGS` and all attribute modifiers) into typed schema files, preserving ClickHouse's `[HIDDEN]` password redaction on `SOURCE(...)` credentials. A `SOURCE(...)` password change diffs and migrates like any other field change; `chkit generate` warns when a literal password is about to be written into migration SQL as plain text. `chkit pull` warns in two cases: when an introspected password comes back as `[HIDDEN]` (chkit can't recover the real value, so that dictionary's `source` is excluded from future diffs until it's replaced), and when ClickHouse is configured to reveal real passwords on introspection (`display_secrets_in_show_and_select` + `displaySecretsInShowAndSelect`), since that writes a plain-text credential into the generated schema file with no other indication. All warnings print to the console and are included as a `warnings` array in `--json` output.
  - `codegen` generates a typed interface (and optional Zod schema) for each dictionary from its `attributes`, always included regardless of `includeViews`.
  - `ON CLUSTER` mode stamps `ON CLUSTER <name>` onto every dictionary DDL statement, including `CREATE OR REPLACE DICTIONARY` and `RENAME DICTIONARY`.

- 3f1db03: Support index-only projections (`PROJECTION p INDEX (a, b) TYPE basic`) end to end. `ProjectionDefinition` is now a union of the existing `{ name, query }` SELECT form and a new `{ name, index, type }` index-only form, which renders without the wrapping parens that made the SELECT form invalid for it. `chkit pull` previously parsed only the SELECT form and dropped index-only projections on the floor, so a pulled schema silently recreated the table without them; they now round-trip through pull, generate, migrate, and drift.

  Index expressions are normalized to the exact form ClickHouse stores — a single expression bare (`INDEX a`), several as a tuple (`INDEX (a, b)`), redundant parens peeled at every level, and a space after each argument separator — so `'(a)'` and `'a'`, or `'concat(x,y)'` and `'concat(x, y)'`, describe the same table and no longer read as drift.

  Two new validation errors guard the new form: `projection_ambiguous_kind` when an entry sets both `query` and `index` (which would otherwise silently discard the SELECT body), and `projection_empty_index` when the index expression is empty (which would otherwise emit invalid DDL).

- 5a8d805: Support ClickHouse function expressions in `primaryKey`/`orderBy` (e.g. `toDate(ts)`, `toStartOfHour(session_end)`). Validation no longer reports `primary_key_missing_column`/`order_by_missing_column` for expression entries, and generated DDL emits them verbatim instead of quoting the whole expression as a column name. Plain column references are still validated and backtick-quoted as before.

  Migration planning now compares key clauses independent of insignificant whitespace and identifier backtick-quoting, so an expression written as `toStartOfHour( ts )` or a column written bare as `user-id` no longer diffs against ClickHouse's normalized `toStartOfHour(ts)` / `` `user-id` `` and triggers a phantom table recreate on `migrate`/`drift`/`check`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.

## 0.1.2-beta.6

### Patch Changes

- 65c90d6: Add `dictionary()` as a first-class ClickHouse schema primitive, mirroring `materializedView()` across the full lifecycle: DSL authoring, validation, canonicalization, SQL rendering, migration planning/diff, drift, `check`, destructive-op safety, `pull` introspection, and `codegen` typed interfaces.

  - `dictionary({ database, name, attributes, primaryKey, source, layout, lifetime, range?, settings?, comment? })` — attributes support `default`/`expression` (mutually exclusive), `hierarchical`, `bidirectional` (requires `hierarchical`), `injective`, and `isObjectId`. `range: { min, max }` renders `RANGE(MIN ... MAX ...)` for `RANGE_HASHED`/`COMPLEX_KEY_RANGE_HASHED` layouts, and `settings` renders `SETTINGS(...)`.
  - ClickHouse has no `ALTER DICTIONARY`, so any structural change plans a single atomic `CREATE OR REPLACE DICTIONARY`. Dropping a dictionary is treated as destructive and blocked without `--allow-destructive`.
  - Set `renamedFrom` on a dictionary (or pass `--rename-dictionary old_db.old=new_db.new` to `chkit generate`) to rename a dictionary via `RENAME DICTIONARY IF EXISTS ... TO ...` instead of a destructive drop + create.
  - `chkit pull` introspects live dictionaries (including `RANGE`/`SETTINGS` and all attribute modifiers) into typed schema files, preserving ClickHouse's `[HIDDEN]` password redaction on `SOURCE(...)` credentials. A `SOURCE(...)` password change diffs and migrates like any other field change; `chkit generate` warns when a literal password is about to be written into migration SQL as plain text. `chkit pull` warns in two cases: when an introspected password comes back as `[HIDDEN]` (chkit can't recover the real value, so that dictionary's `source` is excluded from future diffs until it's replaced), and when ClickHouse is configured to reveal real passwords on introspection (`display_secrets_in_show_and_select` + `displaySecretsInShowAndSelect`), since that writes a plain-text credential into the generated schema file with no other indication. All warnings print to the console and are included as a `warnings` array in `--json` output.
  - `codegen` generates a typed interface (and optional Zod schema) for each dictionary from its `attributes`, always included regardless of `includeViews`.
  - `ON CLUSTER` mode stamps `ON CLUSTER <name>` onto every dictionary DDL statement, including `CREATE OR REPLACE DICTIONARY` and `RENAME DICTIONARY`.

- 3f1db03: Support index-only projections (`PROJECTION p INDEX (a, b) TYPE basic`) end to end. `ProjectionDefinition` is now a union of the existing `{ name, query }` SELECT form and a new `{ name, index, type }` index-only form, which renders without the wrapping parens that made the SELECT form invalid for it. `chkit pull` previously parsed only the SELECT form and dropped index-only projections on the floor, so a pulled schema silently recreated the table without them; they now round-trip through pull, generate, migrate, and drift.

  Index expressions are normalized to the exact form ClickHouse stores — a single expression bare (`INDEX a`), several as a tuple (`INDEX (a, b)`), redundant parens peeled at every level, and a space after each argument separator — so `'(a)'` and `'a'`, or `'concat(x,y)'` and `'concat(x, y)'`, describe the same table and no longer read as drift.

  Two new validation errors guard the new form: `projection_ambiguous_kind` when an entry sets both `query` and `index` (which would otherwise silently discard the SELECT body), and `projection_empty_index` when the index expression is empty (which would otherwise emit invalid DDL).

- 5a8d805: Support ClickHouse function expressions in `primaryKey`/`orderBy` (e.g. `toDate(ts)`, `toStartOfHour(session_end)`). Validation no longer reports `primary_key_missing_column`/`order_by_missing_column` for expression entries, and generated DDL emits them verbatim instead of quoting the whole expression as a column name. Plain column references are still validated and backtick-quoted as before.

  Migration planning now compares key clauses independent of insignificant whitespace and identifier backtick-quoting, so an expression written as `toStartOfHour( ts )` or a column written bare as `user-id` no longer diffs against ClickHouse's normalized `toStartOfHour(ts)` / `` `user-id` `` and triggers a phantom table recreate on `migrate`/`drift`/`check`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.

## 0.1.2-beta.5

### Patch Changes

- 3f1db03: Support index-only projections (`PROJECTION p INDEX (a, b) TYPE basic`) end to end. `ProjectionDefinition` is now a union of the existing `{ name, query }` SELECT form and a new `{ name, index, type }` index-only form, which renders without the wrapping parens that made the SELECT form invalid for it. `chkit pull` previously parsed only the SELECT form and dropped index-only projections on the floor, so a pulled schema silently recreated the table without them; they now round-trip through pull, generate, migrate, and drift.

  Index expressions are normalized to the exact form ClickHouse stores — a single expression bare (`INDEX a`), several as a tuple (`INDEX (a, b)`), redundant parens peeled at every level, and a space after each argument separator — so `'(a)'` and `'a'`, or `'concat(x,y)'` and `'concat(x, y)'`, describe the same table and no longer read as drift.

  Two new validation errors guard the new form: `projection_ambiguous_kind` when an entry sets both `query` and `index` (which would otherwise silently discard the SELECT body), and `projection_empty_index` when the index expression is empty (which would otherwise emit invalid DDL).

- 5a8d805: Support ClickHouse function expressions in `primaryKey`/`orderBy` (e.g. `toDate(ts)`, `toStartOfHour(session_end)`). Validation no longer reports `primary_key_missing_column`/`order_by_missing_column` for expression entries, and generated DDL emits them verbatim instead of quoting the whole expression as a column name. Plain column references are still validated and backtick-quoted as before.

  Migration planning now compares key clauses independent of insignificant whitespace and identifier backtick-quoting, so an expression written as `toStartOfHour( ts )` or a column written bare as `user-id` no longer diffs against ClickHouse's normalized `toStartOfHour(ts)` / `` `user-id` `` and triggers a phantom table recreate on `migrate`/`drift`/`check`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.

## 0.1.2-beta.4

### Patch Changes

- 5a8d805: Support ClickHouse function expressions in `primaryKey`/`orderBy` (e.g. `toDate(ts)`, `toStartOfHour(session_end)`). Validation no longer reports `primary_key_missing_column`/`order_by_missing_column` for expression entries, and generated DDL emits them verbatim instead of quoting the whole expression as a column name. Plain column references are still validated and backtick-quoted as before.

  Migration planning now compares key clauses independent of insignificant whitespace and identifier backtick-quoting, so an expression written as `toStartOfHour( ts )` or a column written bare as `user-id` no longer diffs against ClickHouse's normalized `toStartOfHour(ts)` / `` `user-id` `` and triggers a phantom table recreate on `migrate`/`drift`/`check`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.

## 0.1.2-beta.3

### Patch Changes

- 5a8d805: Support ClickHouse function expressions in `primaryKey`/`orderBy` (e.g. `toDate(ts)`, `toStartOfHour(session_end)`). Validation no longer reports `primary_key_missing_column`/`order_by_missing_column` for expression entries, and generated DDL emits them verbatim instead of quoting the whole expression as a column name. Plain column references are still validated and backtick-quoted as before.

  Migration planning now compares key clauses independent of insignificant whitespace and identifier backtick-quoting, so an expression written as `toStartOfHour( ts )` or a column written bare as `user-id` no longer diffs against ClickHouse's normalized `toStartOfHour(ts)` / `` `user-id` `` and triggers a phantom table recreate on `migrate`/`drift`/`check`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.

## 0.1.2-beta.2

### Patch Changes

- 5a8d805: Support ClickHouse function expressions in `primaryKey`/`orderBy` (e.g. `toDate(ts)`, `toStartOfHour(session_end)`). Validation no longer reports `primary_key_missing_column`/`order_by_missing_column` for expression entries, and generated DDL emits them verbatim instead of quoting the whole expression as a column name. Plain column references are still validated and backtick-quoted as before.

  Migration planning now compares key clauses independent of insignificant whitespace and identifier backtick-quoting, so an expression written as `toStartOfHour( ts )` or a column written bare as `user-id` no longer diffs against ClickHouse's normalized `toStartOfHour(ts)` / `` `user-id` `` and triggers a phantom table recreate on `migrate`/`drift`/`check`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.

## 0.1.2-beta.1

### Patch Changes

- 5a8d805: Support ClickHouse function expressions in `primaryKey`/`orderBy` (e.g. `toDate(ts)`, `toStartOfHour(session_end)`). Validation no longer reports `primary_key_missing_column`/`order_by_missing_column` for expression entries, and generated DDL emits them verbatim instead of quoting the whole expression as a column name. Plain column references are still validated and backtick-quoted as before.

  Migration planning now compares key clauses independent of insignificant whitespace and identifier backtick-quoting, so an expression written as `toStartOfHour( ts )` or a column written bare as `user-id` no longer diffs against ClickHouse's normalized `toStartOfHour(ts)` / `` `user-id` `` and triggers a phantom table recreate on `migrate`/`drift`/`check`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.

## 0.1.2-beta.0

### Patch Changes

- 5a8d805: Support ClickHouse function expressions in `primaryKey`/`orderBy` (e.g. `toDate(ts)`, `toStartOfHour(session_end)`). Validation no longer reports `primary_key_missing_column`/`order_by_missing_column` for expression entries, and generated DDL emits them verbatim instead of quoting the whole expression as a column name. Plain column references are still validated and backtick-quoted as before.

  Migration planning now compares key clauses independent of insignificant whitespace and identifier backtick-quoting, so an expression written as `toStartOfHour( ts )` or a column written bare as `user-id` no longer diffs against ClickHouse's normalized `toStartOfHour(ts)` / `` `user-id` `` and triggers a phantom table recreate on `migrate`/`drift`/`check`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.

## 0.1.1

### Patch Changes

- 6b87e6d: Add ClickHouse cluster support. Set `clickhouse.cluster` in your config to run all generated DDL `ON CLUSTER <name>` and store the migration journal in a replicated engine — for self-managed multi-node clusters. Your table engines are passed through unchanged (declare `ReplicatedMergeTree` yourself). Leave `cluster` unset for single-node, ClickHouse Cloud, or ObsessionDB, where replication is automatic and `ON CLUSTER` is unnecessary.

## 0.1.0

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- ff1cd31: Stop reporting unmanaged tables as drift by default. On a shared database, every object chkit doesn't manage was emitted as `extra_object` and set `drifted = true`, so `drift` always reported drift and `check` (which defaults to `failOnDrift: true`) failed the CI gate permanently for unrelated reasons. Objects that exist in ClickHouse but are not in your schema are now reported for visibility but no longer count as drift. A new `check.failOnExtraObjects` option (default `false`) opts back into treating them as drift, for when chkit owns the entire database.
- d9d5038: Polish error messages and a few noisy outputs:

  - A table defined with `orderBy` but no `primaryKey` no longer crashes with a raw `TypeError`; the primary key defaults to the order-by columns, matching ClickHouse.
  - Built-in command errors (e.g. a rejected migration) surface their own clean message instead of being wrapped in `Plugin "core" failed in ...`.
  - `chkit query` syntax errors no longer leak the injected `FORMAT JSON` clause the user never typed, and the "Expected one of" token dump is capped.
  - Connection errors whose reason is only in the message (no `.code`) — e.g. a typo'd host — are now recognized and cleaned instead of leaking the raw client string.
  - The post-apply message names the resolved journal table (respecting `CHKIT_JOURNAL_TABLE`) instead of a hardcoded `_chkit_migrations`.
  - The ObsessionDB "authenticated but no service selected" reminder is suppressed when a direct `clickhouse` target is configured (it was layered in from a global login, not chosen for the project).

- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 8d5878a: Generate idempotent `RENAME COLUMN` / `RENAME TABLE` statements using `IF EXISTS`. Renames are the one non-idempotent generated DDL: replaying `RENAME COLUMN a TO b` after it already ran fails with "unknown identifier". With `IF EXISTS`, a replay after a partial migration failure (or alongside per-statement resume) is a safe no-op instead of bricking the migration. Applies to both auto-detected rename suggestions and explicit `--rename-column` / `--rename-table` / `renamedFrom` renames.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 5ee4afc: Order materialized-view creates by their `refresh.dependsOn` edges. Creates within the same kind were tie-broken purely by name, so a refreshable materialized view declared `DEPENDS ON other_mv` whose name sorted before its dependency could be created first and fail. The planner now creates a `DEPENDS ON` target before the view that depends on it; independent views keep their stable alphabetical order.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- b0f200d: Add support for per-column compression codecs.

  Declare a codec directly on a column with a structured discriminated union:

  ```ts
  import { codec, table } from "@chkit/core";

  const events = table({
    database: "analytics",
    name: "events",
    columns: [
      { name: "id", type: "UInt64" },
      { name: "ts", type: "DateTime", codec: { kind: "ZSTD", level: 3 } },
      {
        name: "delta",
        type: "Int64",
        codec: [{ kind: "Delta", size: 4 }, { kind: "ZSTD" }],
      },
      { name: "exp", type: "Float32", codec: codec.raw("SomeNewCodec(42)") },
    ],
    engine: "MergeTree()",
    primaryKey: ["id"],
    orderBy: ["id"],
  });
  ```

  Highlights:

  - `CREATE TABLE` and `ALTER TABLE ADD/MODIFY COLUMN` emit the `CODEC(...)` clause in the correct position (after `DEFAULT` and `COMMENT`, as required by ClickHouse).
  - `chkit generate` emits `MODIFY COLUMN ... REMOVE CODEC` when a codec is dropped and no other column fields change; otherwise a single `MODIFY COLUMN` replaces the codec.
  - `chkit pull` introspects `system.columns.compression_codec` and renders structured codec objects back into the schema file. Unknown codec tokens fall back to `codec.raw(...)` so new ClickHouse codecs still round-trip.
  - Canonicalization fills ClickHouse defaults (`ZSTD` → level 1, `LZ4HC` → level 9, `Delta`/`DoubleDelta`/`Gorilla` → size 1), so `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal and the diff engine stays stable across pull → plan round-trips.
  - Validation catches codec chains with more than one general codec, chains that do not end with a general codec, or an empty chain (`codec: []`) — preprocessor alone is accepted since ClickHouse auto-appends the default general codec.
  - `parseCodec` falls back to `raw` when a known codec token has unexpected extra args (e.g. `ZSTD(3, 1)`), so future ClickHouse codec extensions round-trip cleanly through `chkit pull` instead of silently dropping arguments.

- a77c5b2: Add support for ClickHouse refreshable materialized views (RMVs), GA since ClickHouse 24.10.

  Define a refreshable MV by adding a `refresh` field to `materializedView()`:

  ```ts
  const dailyReport = materializedView({
    database: "analytics",
    name: "daily_report_mv",
    to: { database: "analytics", name: "daily_report" },
    refresh: { every: "1 DAY", offset: "2 HOUR" },
    as: "SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day",
  });
  ```

  Supported fields: `every`, `after`, `offset`, `randomize`, `dependsOn`, `settings`, `append`, `empty`.

  Highlights:

  - `chkit generate` emits `ALTER TABLE ... MODIFY REFRESH` for schedule-only changes and `DROP ... SYNC` + `CREATE` for structural changes (added/removed refresh, toggled APPEND).
  - `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that managed ClickHouse environments auto-inject.
  - Validation catches: missing/both `every`/`after`, invalid interval formats, non-APPEND RMV pointing at a replicated (`SharedMergeTree` / `Replicated*`) target (ClickHouse rejects this), and `DEPENDS ON` paired with `REFRESH AFTER`.

  See the [Refreshable materialized views docs](https://chkit.obsessiondb.com/schema/refreshable-views/) for the full reference.

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- b0f200d: **Breaking:** Skip indexes now use a structured discriminated union instead of a free-form `typeArgs: string` field. Each index `type` has its own typed fields, which moves argument validation from runtime to the type system.

  ```ts
  indexes: [
    // before
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      typeArgs: "0",
      granularity: 1,
    },
    // after
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      maxRows: 0,
      granularity: 1,
    },
  ];
  ```

  ### Migration guide

  | Old (`typeArgs`)                               | New (structured)                                                                    |
  | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `type: 'minmax'`                               | `type: 'minmax'`                                                                    |
  | `type: 'set', typeArgs: '0'`                   | `type: 'set', maxRows: 0`                                                           |
  | `type: 'set', typeArgs: '1000'`                | `type: 'set', maxRows: 1000`                                                        |
  | `type: 'bloom_filter'`                         | `type: 'bloom_filter'`                                                              |
  | `type: 'bloom_filter', typeArgs: '0.01'`       | `type: 'bloom_filter', falsePositiveRate: 0.01`                                     |
  | `type: 'tokenbf_v1', typeArgs: '32768, 3, 0'`  | `type: 'tokenbf_v1', sizeBytes: 32768, hashFunctions: 3, randomSeed: 0`             |
  | `type: 'ngrambf_v1', typeArgs: '3, 256, 2, 0'` | `type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0` |

  Highlights:

  - `set` now requires `maxRows` at the type level — forgetting it is a TypeScript error rather than a runtime validation failure.
  - `tokenbf_v1` and `ngrambf_v1` have typed `sizeBytes`, `hashFunctions`, `randomSeed` (and `ngramSize` for ngram), so positional argument mistakes are caught at compile time.
  - `bloom_filter` keeps `falsePositiveRate` optional — omit it to emit a bare `bloom_filter` clause.
  - `chkit pull` now introspects `system.data_skipping_indices.type_full` and emits the structured fields back into schema files; unknown types still round-trip via the existing path.
  - The `index_type_missing_args` validation code is removed since it is now a compile-time concern.

- 0aa2c28: Load `.ts` config and schema files under plain Node, not only Bun. Previously every database command (`status`, `generate`, `migrate`, `check`, `drift`, `query`) failed on Node with `Unknown file extension ".ts"`, despite the docs advertising Node.js 20+. Config and schema modules now load through jiti on Node (and continue to use Bun's native importer under Bun). Also improves the cold-start error when a config can't resolve its dependencies: instead of a raw module-resolution error, chkit now reports which package is missing and tells you to run `bun install` (or `npm`/`pnpm install`).
- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.29

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- ff1cd31: Stop reporting unmanaged tables as drift by default. On a shared database, every object chkit doesn't manage was emitted as `extra_object` and set `drifted = true`, so `drift` always reported drift and `check` (which defaults to `failOnDrift: true`) failed the CI gate permanently for unrelated reasons. Objects that exist in ClickHouse but are not in your schema are now reported for visibility but no longer count as drift. A new `check.failOnExtraObjects` option (default `false`) opts back into treating them as drift, for when chkit owns the entire database.
- d9d5038: Polish error messages and a few noisy outputs:

  - A table defined with `orderBy` but no `primaryKey` no longer crashes with a raw `TypeError`; the primary key defaults to the order-by columns, matching ClickHouse.
  - Built-in command errors (e.g. a rejected migration) surface their own clean message instead of being wrapped in `Plugin "core" failed in ...`.
  - `chkit query` syntax errors no longer leak the injected `FORMAT JSON` clause the user never typed, and the "Expected one of" token dump is capped.
  - Connection errors whose reason is only in the message (no `.code`) — e.g. a typo'd host — are now recognized and cleaned instead of leaking the raw client string.
  - The post-apply message names the resolved journal table (respecting `CHKIT_JOURNAL_TABLE`) instead of a hardcoded `_chkit_migrations`.
  - The ObsessionDB "authenticated but no service selected" reminder is suppressed when a direct `clickhouse` target is configured (it was layered in from a global login, not chosen for the project).

- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 8d5878a: Generate idempotent `RENAME COLUMN` / `RENAME TABLE` statements using `IF EXISTS`. Renames are the one non-idempotent generated DDL: replaying `RENAME COLUMN a TO b` after it already ran fails with "unknown identifier". With `IF EXISTS`, a replay after a partial migration failure (or alongside per-statement resume) is a safe no-op instead of bricking the migration. Applies to both auto-detected rename suggestions and explicit `--rename-column` / `--rename-table` / `renamedFrom` renames.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 5ee4afc: Order materialized-view creates by their `refresh.dependsOn` edges. Creates within the same kind were tie-broken purely by name, so a refreshable materialized view declared `DEPENDS ON other_mv` whose name sorted before its dependency could be created first and fail. The planner now creates a `DEPENDS ON` target before the view that depends on it; independent views keep their stable alphabetical order.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- b0f200d: Add support for per-column compression codecs.

  Declare a codec directly on a column with a structured discriminated union:

  ```ts
  import { codec, table } from "@chkit/core";

  const events = table({
    database: "analytics",
    name: "events",
    columns: [
      { name: "id", type: "UInt64" },
      { name: "ts", type: "DateTime", codec: { kind: "ZSTD", level: 3 } },
      {
        name: "delta",
        type: "Int64",
        codec: [{ kind: "Delta", size: 4 }, { kind: "ZSTD" }],
      },
      { name: "exp", type: "Float32", codec: codec.raw("SomeNewCodec(42)") },
    ],
    engine: "MergeTree()",
    primaryKey: ["id"],
    orderBy: ["id"],
  });
  ```

  Highlights:

  - `CREATE TABLE` and `ALTER TABLE ADD/MODIFY COLUMN` emit the `CODEC(...)` clause in the correct position (after `DEFAULT` and `COMMENT`, as required by ClickHouse).
  - `chkit generate` emits `MODIFY COLUMN ... REMOVE CODEC` when a codec is dropped and no other column fields change; otherwise a single `MODIFY COLUMN` replaces the codec.
  - `chkit pull` introspects `system.columns.compression_codec` and renders structured codec objects back into the schema file. Unknown codec tokens fall back to `codec.raw(...)` so new ClickHouse codecs still round-trip.
  - Canonicalization fills ClickHouse defaults (`ZSTD` → level 1, `LZ4HC` → level 9, `Delta`/`DoubleDelta`/`Gorilla` → size 1), so `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal and the diff engine stays stable across pull → plan round-trips.
  - Validation catches codec chains with more than one general codec, chains that do not end with a general codec, or an empty chain (`codec: []`) — preprocessor alone is accepted since ClickHouse auto-appends the default general codec.
  - `parseCodec` falls back to `raw` when a known codec token has unexpected extra args (e.g. `ZSTD(3, 1)`), so future ClickHouse codec extensions round-trip cleanly through `chkit pull` instead of silently dropping arguments.

- a77c5b2: Add support for ClickHouse refreshable materialized views (RMVs), GA since ClickHouse 24.10.

  Define a refreshable MV by adding a `refresh` field to `materializedView()`:

  ```ts
  const dailyReport = materializedView({
    database: "analytics",
    name: "daily_report_mv",
    to: { database: "analytics", name: "daily_report" },
    refresh: { every: "1 DAY", offset: "2 HOUR" },
    as: "SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day",
  });
  ```

  Supported fields: `every`, `after`, `offset`, `randomize`, `dependsOn`, `settings`, `append`, `empty`.

  Highlights:

  - `chkit generate` emits `ALTER TABLE ... MODIFY REFRESH` for schedule-only changes and `DROP ... SYNC` + `CREATE` for structural changes (added/removed refresh, toggled APPEND).
  - `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that managed ClickHouse environments auto-inject.
  - Validation catches: missing/both `every`/`after`, invalid interval formats, non-APPEND RMV pointing at a replicated (`SharedMergeTree` / `Replicated*`) target (ClickHouse rejects this), and `DEPENDS ON` paired with `REFRESH AFTER`.

  See the [Refreshable materialized views docs](https://chkit.obsessiondb.com/schema/refreshable-views/) for the full reference.

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- b0f200d: **Breaking:** Skip indexes now use a structured discriminated union instead of a free-form `typeArgs: string` field. Each index `type` has its own typed fields, which moves argument validation from runtime to the type system.

  ```ts
  indexes: [
    // before
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      typeArgs: "0",
      granularity: 1,
    },
    // after
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      maxRows: 0,
      granularity: 1,
    },
  ];
  ```

  ### Migration guide

  | Old (`typeArgs`)                               | New (structured)                                                                    |
  | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `type: 'minmax'`                               | `type: 'minmax'`                                                                    |
  | `type: 'set', typeArgs: '0'`                   | `type: 'set', maxRows: 0`                                                           |
  | `type: 'set', typeArgs: '1000'`                | `type: 'set', maxRows: 1000`                                                        |
  | `type: 'bloom_filter'`                         | `type: 'bloom_filter'`                                                              |
  | `type: 'bloom_filter', typeArgs: '0.01'`       | `type: 'bloom_filter', falsePositiveRate: 0.01`                                     |
  | `type: 'tokenbf_v1', typeArgs: '32768, 3, 0'`  | `type: 'tokenbf_v1', sizeBytes: 32768, hashFunctions: 3, randomSeed: 0`             |
  | `type: 'ngrambf_v1', typeArgs: '3, 256, 2, 0'` | `type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0` |

  Highlights:

  - `set` now requires `maxRows` at the type level — forgetting it is a TypeScript error rather than a runtime validation failure.
  - `tokenbf_v1` and `ngrambf_v1` have typed `sizeBytes`, `hashFunctions`, `randomSeed` (and `ngramSize` for ngram), so positional argument mistakes are caught at compile time.
  - `bloom_filter` keeps `falsePositiveRate` optional — omit it to emit a bare `bloom_filter` clause.
  - `chkit pull` now introspects `system.data_skipping_indices.type_full` and emits the structured fields back into schema files; unknown types still round-trip via the existing path.
  - The `index_type_missing_args` validation code is removed since it is now a compile-time concern.

- 0aa2c28: Load `.ts` config and schema files under plain Node, not only Bun. Previously every database command (`status`, `generate`, `migrate`, `check`, `drift`, `query`) failed on Node with `Unknown file extension ".ts"`, despite the docs advertising Node.js 20+. Config and schema modules now load through jiti on Node (and continue to use Bun's native importer under Bun). Also improves the cold-start error when a config can't resolve its dependencies: instead of a raw module-resolution error, chkit now reports which package is missing and tells you to run `bun install` (or `npm`/`pnpm install`).
- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.28

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- b0f200d: Add support for per-column compression codecs.

  Declare a codec directly on a column with a structured discriminated union:

  ```ts
  import { codec, table } from "@chkit/core";

  const events = table({
    database: "analytics",
    name: "events",
    columns: [
      { name: "id", type: "UInt64" },
      { name: "ts", type: "DateTime", codec: { kind: "ZSTD", level: 3 } },
      {
        name: "delta",
        type: "Int64",
        codec: [{ kind: "Delta", size: 4 }, { kind: "ZSTD" }],
      },
      { name: "exp", type: "Float32", codec: codec.raw("SomeNewCodec(42)") },
    ],
    engine: "MergeTree()",
    primaryKey: ["id"],
    orderBy: ["id"],
  });
  ```

  Highlights:

  - `CREATE TABLE` and `ALTER TABLE ADD/MODIFY COLUMN` emit the `CODEC(...)` clause in the correct position (after `DEFAULT` and `COMMENT`, as required by ClickHouse).
  - `chkit generate` emits `MODIFY COLUMN ... REMOVE CODEC` when a codec is dropped and no other column fields change; otherwise a single `MODIFY COLUMN` replaces the codec.
  - `chkit pull` introspects `system.columns.compression_codec` and renders structured codec objects back into the schema file. Unknown codec tokens fall back to `codec.raw(...)` so new ClickHouse codecs still round-trip.
  - Canonicalization fills ClickHouse defaults (`ZSTD` → level 1, `LZ4HC` → level 9, `Delta`/`DoubleDelta`/`Gorilla` → size 1), so `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal and the diff engine stays stable across pull → plan round-trips.
  - Validation catches codec chains with more than one general codec, chains that do not end with a general codec, or an empty chain (`codec: []`) — preprocessor alone is accepted since ClickHouse auto-appends the default general codec.
  - `parseCodec` falls back to `raw` when a known codec token has unexpected extra args (e.g. `ZSTD(3, 1)`), so future ClickHouse codec extensions round-trip cleanly through `chkit pull` instead of silently dropping arguments.

- a77c5b2: Add support for ClickHouse refreshable materialized views (RMVs), GA since ClickHouse 24.10.

  Define a refreshable MV by adding a `refresh` field to `materializedView()`:

  ```ts
  const dailyReport = materializedView({
    database: "analytics",
    name: "daily_report_mv",
    to: { database: "analytics", name: "daily_report" },
    refresh: { every: "1 DAY", offset: "2 HOUR" },
    as: "SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day",
  });
  ```

  Supported fields: `every`, `after`, `offset`, `randomize`, `dependsOn`, `settings`, `append`, `empty`.

  Highlights:

  - `chkit generate` emits `ALTER TABLE ... MODIFY REFRESH` for schedule-only changes and `DROP ... SYNC` + `CREATE` for structural changes (added/removed refresh, toggled APPEND).
  - `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that managed ClickHouse environments auto-inject.
  - Validation catches: missing/both `every`/`after`, invalid interval formats, non-APPEND RMV pointing at a replicated (`SharedMergeTree` / `Replicated*`) target (ClickHouse rejects this), and `DEPENDS ON` paired with `REFRESH AFTER`.

  See the [Refreshable materialized views docs](https://chkit.obsessiondb.com/schema/refreshable-views/) for the full reference.

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- b0f200d: **Breaking:** Skip indexes now use a structured discriminated union instead of a free-form `typeArgs: string` field. Each index `type` has its own typed fields, which moves argument validation from runtime to the type system.

  ```ts
  indexes: [
    // before
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      typeArgs: "0",
      granularity: 1,
    },
    // after
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      maxRows: 0,
      granularity: 1,
    },
  ];
  ```

  ### Migration guide

  | Old (`typeArgs`)                               | New (structured)                                                                    |
  | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `type: 'minmax'`                               | `type: 'minmax'`                                                                    |
  | `type: 'set', typeArgs: '0'`                   | `type: 'set', maxRows: 0`                                                           |
  | `type: 'set', typeArgs: '1000'`                | `type: 'set', maxRows: 1000`                                                        |
  | `type: 'bloom_filter'`                         | `type: 'bloom_filter'`                                                              |
  | `type: 'bloom_filter', typeArgs: '0.01'`       | `type: 'bloom_filter', falsePositiveRate: 0.01`                                     |
  | `type: 'tokenbf_v1', typeArgs: '32768, 3, 0'`  | `type: 'tokenbf_v1', sizeBytes: 32768, hashFunctions: 3, randomSeed: 0`             |
  | `type: 'ngrambf_v1', typeArgs: '3, 256, 2, 0'` | `type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0` |

  Highlights:

  - `set` now requires `maxRows` at the type level — forgetting it is a TypeScript error rather than a runtime validation failure.
  - `tokenbf_v1` and `ngrambf_v1` have typed `sizeBytes`, `hashFunctions`, `randomSeed` (and `ngramSize` for ngram), so positional argument mistakes are caught at compile time.
  - `bloom_filter` keeps `falsePositiveRate` optional — omit it to emit a bare `bloom_filter` clause.
  - `chkit pull` now introspects `system.data_skipping_indices.type_full` and emits the structured fields back into schema files; unknown types still round-trip via the existing path.
  - The `index_type_missing_args` validation code is removed since it is now a compile-time concern.

- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.27

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- b0f200d: Add support for per-column compression codecs.

  Declare a codec directly on a column with a structured discriminated union:

  ```ts
  import { codec, table } from "@chkit/core";

  const events = table({
    database: "analytics",
    name: "events",
    columns: [
      { name: "id", type: "UInt64" },
      { name: "ts", type: "DateTime", codec: { kind: "ZSTD", level: 3 } },
      {
        name: "delta",
        type: "Int64",
        codec: [{ kind: "Delta", size: 4 }, { kind: "ZSTD" }],
      },
      { name: "exp", type: "Float32", codec: codec.raw("SomeNewCodec(42)") },
    ],
    engine: "MergeTree()",
    primaryKey: ["id"],
    orderBy: ["id"],
  });
  ```

  Highlights:

  - `CREATE TABLE` and `ALTER TABLE ADD/MODIFY COLUMN` emit the `CODEC(...)` clause in the correct position (after `DEFAULT` and `COMMENT`, as required by ClickHouse).
  - `chkit generate` emits `MODIFY COLUMN ... REMOVE CODEC` when a codec is dropped and no other column fields change; otherwise a single `MODIFY COLUMN` replaces the codec.
  - `chkit pull` introspects `system.columns.compression_codec` and renders structured codec objects back into the schema file. Unknown codec tokens fall back to `codec.raw(...)` so new ClickHouse codecs still round-trip.
  - Canonicalization fills ClickHouse defaults (`ZSTD` → level 1, `LZ4HC` → level 9, `Delta`/`DoubleDelta`/`Gorilla` → size 1), so `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal and the diff engine stays stable across pull → plan round-trips.
  - Validation catches codec chains with more than one general codec, chains that do not end with a general codec, or an empty chain (`codec: []`) — preprocessor alone is accepted since ClickHouse auto-appends the default general codec.
  - `parseCodec` falls back to `raw` when a known codec token has unexpected extra args (e.g. `ZSTD(3, 1)`), so future ClickHouse codec extensions round-trip cleanly through `chkit pull` instead of silently dropping arguments.

- a77c5b2: Add support for ClickHouse refreshable materialized views (RMVs), GA since ClickHouse 24.10.

  Define a refreshable MV by adding a `refresh` field to `materializedView()`:

  ```ts
  const dailyReport = materializedView({
    database: "analytics",
    name: "daily_report_mv",
    to: { database: "analytics", name: "daily_report" },
    refresh: { every: "1 DAY", offset: "2 HOUR" },
    as: "SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day",
  });
  ```

  Supported fields: `every`, `after`, `offset`, `randomize`, `dependsOn`, `settings`, `append`, `empty`.

  Highlights:

  - `chkit generate` emits `ALTER TABLE ... MODIFY REFRESH` for schedule-only changes and `DROP ... SYNC` + `CREATE` for structural changes (added/removed refresh, toggled APPEND).
  - `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that managed ClickHouse environments auto-inject.
  - Validation catches: missing/both `every`/`after`, invalid interval formats, non-APPEND RMV pointing at a replicated (`SharedMergeTree` / `Replicated*`) target (ClickHouse rejects this), and `DEPENDS ON` paired with `REFRESH AFTER`.

  See the [Refreshable materialized views docs](https://chkit.obsessiondb.com/schema/refreshable-views/) for the full reference.

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- b0f200d: **Breaking:** Skip indexes now use a structured discriminated union instead of a free-form `typeArgs: string` field. Each index `type` has its own typed fields, which moves argument validation from runtime to the type system.

  ```ts
  indexes: [
    // before
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      typeArgs: "0",
      granularity: 1,
    },
    // after
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      maxRows: 0,
      granularity: 1,
    },
  ];
  ```

  ### Migration guide

  | Old (`typeArgs`)                               | New (structured)                                                                    |
  | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `type: 'minmax'`                               | `type: 'minmax'`                                                                    |
  | `type: 'set', typeArgs: '0'`                   | `type: 'set', maxRows: 0`                                                           |
  | `type: 'set', typeArgs: '1000'`                | `type: 'set', maxRows: 1000`                                                        |
  | `type: 'bloom_filter'`                         | `type: 'bloom_filter'`                                                              |
  | `type: 'bloom_filter', typeArgs: '0.01'`       | `type: 'bloom_filter', falsePositiveRate: 0.01`                                     |
  | `type: 'tokenbf_v1', typeArgs: '32768, 3, 0'`  | `type: 'tokenbf_v1', sizeBytes: 32768, hashFunctions: 3, randomSeed: 0`             |
  | `type: 'ngrambf_v1', typeArgs: '3, 256, 2, 0'` | `type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0` |

  Highlights:

  - `set` now requires `maxRows` at the type level — forgetting it is a TypeScript error rather than a runtime validation failure.
  - `tokenbf_v1` and `ngrambf_v1` have typed `sizeBytes`, `hashFunctions`, `randomSeed` (and `ngramSize` for ngram), so positional argument mistakes are caught at compile time.
  - `bloom_filter` keeps `falsePositiveRate` optional — omit it to emit a bare `bloom_filter` clause.
  - `chkit pull` now introspects `system.data_skipping_indices.type_full` and emits the structured fields back into schema files; unknown types still round-trip via the existing path.
  - The `index_type_missing_args` validation code is removed since it is now a compile-time concern.

- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.26

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- b0f200d: Add support for per-column compression codecs.

  Declare a codec directly on a column with a structured discriminated union:

  ```ts
  import { codec, table } from "@chkit/core";

  const events = table({
    database: "analytics",
    name: "events",
    columns: [
      { name: "id", type: "UInt64" },
      { name: "ts", type: "DateTime", codec: { kind: "ZSTD", level: 3 } },
      {
        name: "delta",
        type: "Int64",
        codec: [{ kind: "Delta", size: 4 }, { kind: "ZSTD" }],
      },
      { name: "exp", type: "Float32", codec: codec.raw("SomeNewCodec(42)") },
    ],
    engine: "MergeTree()",
    primaryKey: ["id"],
    orderBy: ["id"],
  });
  ```

  Highlights:

  - `CREATE TABLE` and `ALTER TABLE ADD/MODIFY COLUMN` emit the `CODEC(...)` clause in the correct position (after `DEFAULT` and `COMMENT`, as required by ClickHouse).
  - `chkit generate` emits `MODIFY COLUMN ... REMOVE CODEC` when a codec is dropped and no other column fields change; otherwise a single `MODIFY COLUMN` replaces the codec.
  - `chkit pull` introspects `system.columns.compression_codec` and renders structured codec objects back into the schema file. Unknown codec tokens fall back to `codec.raw(...)` so new ClickHouse codecs still round-trip.
  - Canonicalization fills ClickHouse defaults (`ZSTD` → level 1, `LZ4HC` → level 9, `Delta`/`DoubleDelta`/`Gorilla` → size 1), so `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal and the diff engine stays stable across pull → plan round-trips.
  - Validation catches codec chains with more than one general codec, chains that do not end with a general codec, or an empty chain (`codec: []`) — preprocessor alone is accepted since ClickHouse auto-appends the default general codec.
  - `parseCodec` falls back to `raw` when a known codec token has unexpected extra args (e.g. `ZSTD(3, 1)`), so future ClickHouse codec extensions round-trip cleanly through `chkit pull` instead of silently dropping arguments.

- a77c5b2: Add support for ClickHouse refreshable materialized views (RMVs), GA since ClickHouse 24.10.

  Define a refreshable MV by adding a `refresh` field to `materializedView()`:

  ```ts
  const dailyReport = materializedView({
    database: "analytics",
    name: "daily_report_mv",
    to: { database: "analytics", name: "daily_report" },
    refresh: { every: "1 DAY", offset: "2 HOUR" },
    as: "SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day",
  });
  ```

  Supported fields: `every`, `after`, `offset`, `randomize`, `dependsOn`, `settings`, `append`, `empty`.

  Highlights:

  - `chkit generate` emits `ALTER TABLE ... MODIFY REFRESH` for schedule-only changes and `DROP ... SYNC` + `CREATE` for structural changes (added/removed refresh, toggled APPEND).
  - `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that managed ClickHouse environments auto-inject.
  - Validation catches: missing/both `every`/`after`, invalid interval formats, non-APPEND RMV pointing at a replicated (`SharedMergeTree` / `Replicated*`) target (ClickHouse rejects this), and `DEPENDS ON` paired with `REFRESH AFTER`.

  See the [Refreshable materialized views docs](https://chkit.obsessiondb.com/schema/refreshable-views/) for the full reference.

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- b0f200d: **Breaking:** Skip indexes now use a structured discriminated union instead of a free-form `typeArgs: string` field. Each index `type` has its own typed fields, which moves argument validation from runtime to the type system.

  ```ts
  indexes: [
    // before
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      typeArgs: "0",
      granularity: 1,
    },
    // after
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      maxRows: 0,
      granularity: 1,
    },
  ];
  ```

  ### Migration guide

  | Old (`typeArgs`)                               | New (structured)                                                                    |
  | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `type: 'minmax'`                               | `type: 'minmax'`                                                                    |
  | `type: 'set', typeArgs: '0'`                   | `type: 'set', maxRows: 0`                                                           |
  | `type: 'set', typeArgs: '1000'`                | `type: 'set', maxRows: 1000`                                                        |
  | `type: 'bloom_filter'`                         | `type: 'bloom_filter'`                                                              |
  | `type: 'bloom_filter', typeArgs: '0.01'`       | `type: 'bloom_filter', falsePositiveRate: 0.01`                                     |
  | `type: 'tokenbf_v1', typeArgs: '32768, 3, 0'`  | `type: 'tokenbf_v1', sizeBytes: 32768, hashFunctions: 3, randomSeed: 0`             |
  | `type: 'ngrambf_v1', typeArgs: '3, 256, 2, 0'` | `type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0` |

  Highlights:

  - `set` now requires `maxRows` at the type level — forgetting it is a TypeScript error rather than a runtime validation failure.
  - `tokenbf_v1` and `ngrambf_v1` have typed `sizeBytes`, `hashFunctions`, `randomSeed` (and `ngramSize` for ngram), so positional argument mistakes are caught at compile time.
  - `bloom_filter` keeps `falsePositiveRate` optional — omit it to emit a bare `bloom_filter` clause.
  - `chkit pull` now introspects `system.data_skipping_indices.type_full` and emits the structured fields back into schema files; unknown types still round-trip via the existing path.
  - The `index_type_missing_args` validation code is removed since it is now a compile-time concern.

- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.25

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- b0f200d: Add support for per-column compression codecs.

  Declare a codec directly on a column with a structured discriminated union:

  ```ts
  import { codec, table } from "@chkit/core";

  const events = table({
    database: "analytics",
    name: "events",
    columns: [
      { name: "id", type: "UInt64" },
      { name: "ts", type: "DateTime", codec: { kind: "ZSTD", level: 3 } },
      {
        name: "delta",
        type: "Int64",
        codec: [{ kind: "Delta", size: 4 }, { kind: "ZSTD" }],
      },
      { name: "exp", type: "Float32", codec: codec.raw("SomeNewCodec(42)") },
    ],
    engine: "MergeTree()",
    primaryKey: ["id"],
    orderBy: ["id"],
  });
  ```

  Highlights:

  - `CREATE TABLE` and `ALTER TABLE ADD/MODIFY COLUMN` emit the `CODEC(...)` clause in the correct position (after `DEFAULT` and `COMMENT`, as required by ClickHouse).
  - `chkit generate` emits `MODIFY COLUMN ... REMOVE CODEC` when a codec is dropped and no other column fields change; otherwise a single `MODIFY COLUMN` replaces the codec.
  - `chkit pull` introspects `system.columns.compression_codec` and renders structured codec objects back into the schema file. Unknown codec tokens fall back to `codec.raw(...)` so new ClickHouse codecs still round-trip.
  - Canonicalization fills ClickHouse defaults (`ZSTD` → level 1, `LZ4HC` → level 9, `Delta`/`DoubleDelta`/`Gorilla` → size 1), so `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal and the diff engine stays stable across pull → plan round-trips.
  - Validation catches codec chains with more than one general codec, chains that do not end with a general codec, or an empty chain (`codec: []`) — preprocessor alone is accepted since ClickHouse auto-appends the default general codec.
  - `parseCodec` falls back to `raw` when a known codec token has unexpected extra args (e.g. `ZSTD(3, 1)`), so future ClickHouse codec extensions round-trip cleanly through `chkit pull` instead of silently dropping arguments.

- a77c5b2: Add support for ClickHouse refreshable materialized views (RMVs), GA since ClickHouse 24.10.

  Define a refreshable MV by adding a `refresh` field to `materializedView()`:

  ```ts
  const dailyReport = materializedView({
    database: "analytics",
    name: "daily_report_mv",
    to: { database: "analytics", name: "daily_report" },
    refresh: { every: "1 DAY", offset: "2 HOUR" },
    as: "SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day",
  });
  ```

  Supported fields: `every`, `after`, `offset`, `randomize`, `dependsOn`, `settings`, `append`, `empty`.

  Highlights:

  - `chkit generate` emits `ALTER TABLE ... MODIFY REFRESH` for schedule-only changes and `DROP ... SYNC` + `CREATE` for structural changes (added/removed refresh, toggled APPEND).
  - `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that managed ClickHouse environments auto-inject.
  - Validation catches: missing/both `every`/`after`, invalid interval formats, non-APPEND RMV pointing at a replicated (`SharedMergeTree` / `Replicated*`) target (ClickHouse rejects this), and `DEPENDS ON` paired with `REFRESH AFTER`.

  See the [Refreshable materialized views docs](https://chkit.obsessiondb.com/schema/refreshable-views/) for the full reference.

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- b0f200d: **Breaking:** Skip indexes now use a structured discriminated union instead of a free-form `typeArgs: string` field. Each index `type` has its own typed fields, which moves argument validation from runtime to the type system.

  ```ts
  indexes: [
    // before
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      typeArgs: "0",
      granularity: 1,
    },
    // after
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      maxRows: 0,
      granularity: 1,
    },
  ];
  ```

  ### Migration guide

  | Old (`typeArgs`)                               | New (structured)                                                                    |
  | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `type: 'minmax'`                               | `type: 'minmax'`                                                                    |
  | `type: 'set', typeArgs: '0'`                   | `type: 'set', maxRows: 0`                                                           |
  | `type: 'set', typeArgs: '1000'`                | `type: 'set', maxRows: 1000`                                                        |
  | `type: 'bloom_filter'`                         | `type: 'bloom_filter'`                                                              |
  | `type: 'bloom_filter', typeArgs: '0.01'`       | `type: 'bloom_filter', falsePositiveRate: 0.01`                                     |
  | `type: 'tokenbf_v1', typeArgs: '32768, 3, 0'`  | `type: 'tokenbf_v1', sizeBytes: 32768, hashFunctions: 3, randomSeed: 0`             |
  | `type: 'ngrambf_v1', typeArgs: '3, 256, 2, 0'` | `type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0` |

  Highlights:

  - `set` now requires `maxRows` at the type level — forgetting it is a TypeScript error rather than a runtime validation failure.
  - `tokenbf_v1` and `ngrambf_v1` have typed `sizeBytes`, `hashFunctions`, `randomSeed` (and `ngramSize` for ngram), so positional argument mistakes are caught at compile time.
  - `bloom_filter` keeps `falsePositiveRate` optional — omit it to emit a bare `bloom_filter` clause.
  - `chkit pull` now introspects `system.data_skipping_indices.type_full` and emits the structured fields back into schema files; unknown types still round-trip via the existing path.
  - The `index_type_missing_args` validation code is removed since it is now a compile-time concern.

- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.24

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- b0f200d: Add support for per-column compression codecs.

  Declare a codec directly on a column with a structured discriminated union:

  ```ts
  import { codec, table } from "@chkit/core";

  const events = table({
    database: "analytics",
    name: "events",
    columns: [
      { name: "id", type: "UInt64" },
      { name: "ts", type: "DateTime", codec: { kind: "ZSTD", level: 3 } },
      {
        name: "delta",
        type: "Int64",
        codec: [{ kind: "Delta", size: 4 }, { kind: "ZSTD" }],
      },
      { name: "exp", type: "Float32", codec: codec.raw("SomeNewCodec(42)") },
    ],
    engine: "MergeTree()",
    primaryKey: ["id"],
    orderBy: ["id"],
  });
  ```

  Highlights:

  - `CREATE TABLE` and `ALTER TABLE ADD/MODIFY COLUMN` emit the `CODEC(...)` clause in the correct position (after `DEFAULT` and `COMMENT`, as required by ClickHouse).
  - `chkit generate` emits `MODIFY COLUMN ... REMOVE CODEC` when a codec is dropped and no other column fields change; otherwise a single `MODIFY COLUMN` replaces the codec.
  - `chkit pull` introspects `system.columns.compression_codec` and renders structured codec objects back into the schema file. Unknown codec tokens fall back to `codec.raw(...)` so new ClickHouse codecs still round-trip.
  - Canonicalization fills ClickHouse defaults (`ZSTD` → level 1, `LZ4HC` → level 9, `Delta`/`DoubleDelta`/`Gorilla` → size 1), so `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal and the diff engine stays stable across pull → plan round-trips.
  - Validation catches codec chains with more than one general codec, chains that do not end with a general codec, or an empty chain (`codec: []`) — preprocessor alone is accepted since ClickHouse auto-appends the default general codec.
  - `parseCodec` falls back to `raw` when a known codec token has unexpected extra args (e.g. `ZSTD(3, 1)`), so future ClickHouse codec extensions round-trip cleanly through `chkit pull` instead of silently dropping arguments.

- a77c5b2: Add support for ClickHouse refreshable materialized views (RMVs), GA since ClickHouse 24.10.

  Define a refreshable MV by adding a `refresh` field to `materializedView()`:

  ```ts
  const dailyReport = materializedView({
    database: "analytics",
    name: "daily_report_mv",
    to: { database: "analytics", name: "daily_report" },
    refresh: { every: "1 DAY", offset: "2 HOUR" },
    as: "SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day",
  });
  ```

  Supported fields: `every`, `after`, `offset`, `randomize`, `dependsOn`, `settings`, `append`, `empty`.

  Highlights:

  - `chkit generate` emits `ALTER TABLE ... MODIFY REFRESH` for schedule-only changes and `DROP ... SYNC` + `CREATE` for structural changes (added/removed refresh, toggled APPEND).
  - `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that managed ClickHouse environments auto-inject.
  - Validation catches: missing/both `every`/`after`, invalid interval formats, non-APPEND RMV pointing at a replicated (`SharedMergeTree` / `Replicated*`) target (ClickHouse rejects this), and `DEPENDS ON` paired with `REFRESH AFTER`.

  See the [Refreshable materialized views docs](https://chkit.obsessiondb.com/schema/refreshable-views/) for the full reference.

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- b0f200d: **Breaking:** Skip indexes now use a structured discriminated union instead of a free-form `typeArgs: string` field. Each index `type` has its own typed fields, which moves argument validation from runtime to the type system.

  ```ts
  indexes: [
    // before
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      typeArgs: "0",
      granularity: 1,
    },
    // after
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      maxRows: 0,
      granularity: 1,
    },
  ];
  ```

  ### Migration guide

  | Old (`typeArgs`)                               | New (structured)                                                                    |
  | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `type: 'minmax'`                               | `type: 'minmax'`                                                                    |
  | `type: 'set', typeArgs: '0'`                   | `type: 'set', maxRows: 0`                                                           |
  | `type: 'set', typeArgs: '1000'`                | `type: 'set', maxRows: 1000`                                                        |
  | `type: 'bloom_filter'`                         | `type: 'bloom_filter'`                                                              |
  | `type: 'bloom_filter', typeArgs: '0.01'`       | `type: 'bloom_filter', falsePositiveRate: 0.01`                                     |
  | `type: 'tokenbf_v1', typeArgs: '32768, 3, 0'`  | `type: 'tokenbf_v1', sizeBytes: 32768, hashFunctions: 3, randomSeed: 0`             |
  | `type: 'ngrambf_v1', typeArgs: '3, 256, 2, 0'` | `type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0` |

  Highlights:

  - `set` now requires `maxRows` at the type level — forgetting it is a TypeScript error rather than a runtime validation failure.
  - `tokenbf_v1` and `ngrambf_v1` have typed `sizeBytes`, `hashFunctions`, `randomSeed` (and `ngramSize` for ngram), so positional argument mistakes are caught at compile time.
  - `bloom_filter` keeps `falsePositiveRate` optional — omit it to emit a bare `bloom_filter` clause.
  - `chkit pull` now introspects `system.data_skipping_indices.type_full` and emits the structured fields back into schema files; unknown types still round-trip via the existing path.
  - The `index_type_missing_args` validation code is removed since it is now a compile-time concern.

- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.23

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- b0f200d: Add support for per-column compression codecs.

  Declare a codec directly on a column with a structured discriminated union:

  ```ts
  import { codec, table } from "@chkit/core";

  const events = table({
    database: "analytics",
    name: "events",
    columns: [
      { name: "id", type: "UInt64" },
      { name: "ts", type: "DateTime", codec: { kind: "ZSTD", level: 3 } },
      {
        name: "delta",
        type: "Int64",
        codec: [{ kind: "Delta", size: 4 }, { kind: "ZSTD" }],
      },
      { name: "exp", type: "Float32", codec: codec.raw("SomeNewCodec(42)") },
    ],
    engine: "MergeTree()",
    primaryKey: ["id"],
    orderBy: ["id"],
  });
  ```

  Highlights:

  - `CREATE TABLE` and `ALTER TABLE ADD/MODIFY COLUMN` emit the `CODEC(...)` clause in the correct position (after `DEFAULT` and `COMMENT`, as required by ClickHouse).
  - `chkit generate` emits `MODIFY COLUMN ... REMOVE CODEC` when a codec is dropped and no other column fields change; otherwise a single `MODIFY COLUMN` replaces the codec.
  - `chkit pull` introspects `system.columns.compression_codec` and renders structured codec objects back into the schema file. Unknown codec tokens fall back to `codec.raw(...)` so new ClickHouse codecs still round-trip.
  - Canonicalization fills ClickHouse defaults (`ZSTD` → level 1, `LZ4HC` → level 9, `Delta`/`DoubleDelta`/`Gorilla` → size 1), so `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal and the diff engine stays stable across pull → plan round-trips.
  - Validation catches codec chains with more than one general codec, chains that do not end with a general codec, or an empty chain (`codec: []`) — preprocessor alone is accepted since ClickHouse auto-appends the default general codec.
  - `parseCodec` falls back to `raw` when a known codec token has unexpected extra args (e.g. `ZSTD(3, 1)`), so future ClickHouse codec extensions round-trip cleanly through `chkit pull` instead of silently dropping arguments.

- a77c5b2: Add support for ClickHouse refreshable materialized views (RMVs), GA since ClickHouse 24.10.

  Define a refreshable MV by adding a `refresh` field to `materializedView()`:

  ```ts
  const dailyReport = materializedView({
    database: "analytics",
    name: "daily_report_mv",
    to: { database: "analytics", name: "daily_report" },
    refresh: { every: "1 DAY", offset: "2 HOUR" },
    as: "SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day",
  });
  ```

  Supported fields: `every`, `after`, `offset`, `randomize`, `dependsOn`, `settings`, `append`, `empty`.

  Highlights:

  - `chkit generate` emits `ALTER TABLE ... MODIFY REFRESH` for schedule-only changes and `DROP ... SYNC` + `CREATE` for structural changes (added/removed refresh, toggled APPEND).
  - `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that managed ClickHouse environments auto-inject.
  - Validation catches: missing/both `every`/`after`, invalid interval formats, non-APPEND RMV pointing at a replicated (`SharedMergeTree` / `Replicated*`) target (ClickHouse rejects this), and `DEPENDS ON` paired with `REFRESH AFTER`.

  See the [Refreshable materialized views docs](https://chkit.obsessiondb.com/schema/refreshable-views/) for the full reference.

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- b0f200d: **Breaking:** Skip indexes now use a structured discriminated union instead of a free-form `typeArgs: string` field. Each index `type` has its own typed fields, which moves argument validation from runtime to the type system.

  ```ts
  indexes: [
    // before
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      typeArgs: "0",
      granularity: 1,
    },
    // after
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      maxRows: 0,
      granularity: 1,
    },
  ];
  ```

  ### Migration guide

  | Old (`typeArgs`)                               | New (structured)                                                                    |
  | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `type: 'minmax'`                               | `type: 'minmax'`                                                                    |
  | `type: 'set', typeArgs: '0'`                   | `type: 'set', maxRows: 0`                                                           |
  | `type: 'set', typeArgs: '1000'`                | `type: 'set', maxRows: 1000`                                                        |
  | `type: 'bloom_filter'`                         | `type: 'bloom_filter'`                                                              |
  | `type: 'bloom_filter', typeArgs: '0.01'`       | `type: 'bloom_filter', falsePositiveRate: 0.01`                                     |
  | `type: 'tokenbf_v1', typeArgs: '32768, 3, 0'`  | `type: 'tokenbf_v1', sizeBytes: 32768, hashFunctions: 3, randomSeed: 0`             |
  | `type: 'ngrambf_v1', typeArgs: '3, 256, 2, 0'` | `type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0` |

  Highlights:

  - `set` now requires `maxRows` at the type level — forgetting it is a TypeScript error rather than a runtime validation failure.
  - `tokenbf_v1` and `ngrambf_v1` have typed `sizeBytes`, `hashFunctions`, `randomSeed` (and `ngramSize` for ngram), so positional argument mistakes are caught at compile time.
  - `bloom_filter` keeps `falsePositiveRate` optional — omit it to emit a bare `bloom_filter` clause.
  - `chkit pull` now introspects `system.data_skipping_indices.type_full` and emits the structured fields back into schema files; unknown types still round-trip via the existing path.
  - The `index_type_missing_args` validation code is removed since it is now a compile-time concern.

- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.22

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- b0f200d: Add support for per-column compression codecs.

  Declare a codec directly on a column with a structured discriminated union:

  ```ts
  import { codec, table } from "@chkit/core";

  const events = table({
    database: "analytics",
    name: "events",
    columns: [
      { name: "id", type: "UInt64" },
      { name: "ts", type: "DateTime", codec: { kind: "ZSTD", level: 3 } },
      {
        name: "delta",
        type: "Int64",
        codec: [{ kind: "Delta", size: 4 }, { kind: "ZSTD" }],
      },
      { name: "exp", type: "Float32", codec: codec.raw("SomeNewCodec(42)") },
    ],
    engine: "MergeTree()",
    primaryKey: ["id"],
    orderBy: ["id"],
  });
  ```

  Highlights:

  - `CREATE TABLE` and `ALTER TABLE ADD/MODIFY COLUMN` emit the `CODEC(...)` clause in the correct position (after `DEFAULT` and `COMMENT`, as required by ClickHouse).
  - `chkit generate` emits `MODIFY COLUMN ... REMOVE CODEC` when a codec is dropped and no other column fields change; otherwise a single `MODIFY COLUMN` replaces the codec.
  - `chkit pull` introspects `system.columns.compression_codec` and renders structured codec objects back into the schema file. Unknown codec tokens fall back to `codec.raw(...)` so new ClickHouse codecs still round-trip.
  - Canonicalization fills ClickHouse defaults (`ZSTD` → level 1, `LZ4HC` → level 9, `Delta`/`DoubleDelta`/`Gorilla` → size 1), so `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal and the diff engine stays stable across pull → plan round-trips.
  - Validation catches codec chains with more than one general codec, chains that do not end with a general codec, or an empty chain (`codec: []`) — preprocessor alone is accepted since ClickHouse auto-appends the default general codec.
  - `parseCodec` falls back to `raw` when a known codec token has unexpected extra args (e.g. `ZSTD(3, 1)`), so future ClickHouse codec extensions round-trip cleanly through `chkit pull` instead of silently dropping arguments.

- a77c5b2: Add support for ClickHouse refreshable materialized views (RMVs), GA since ClickHouse 24.10.

  Define a refreshable MV by adding a `refresh` field to `materializedView()`:

  ```ts
  const dailyReport = materializedView({
    database: "analytics",
    name: "daily_report_mv",
    to: { database: "analytics", name: "daily_report" },
    refresh: { every: "1 DAY", offset: "2 HOUR" },
    as: "SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day",
  });
  ```

  Supported fields: `every`, `after`, `offset`, `randomize`, `dependsOn`, `settings`, `append`, `empty`.

  Highlights:

  - `chkit generate` emits `ALTER TABLE ... MODIFY REFRESH` for schedule-only changes and `DROP ... SYNC` + `CREATE` for structural changes (added/removed refresh, toggled APPEND).
  - `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that managed ClickHouse environments auto-inject.
  - Validation catches: missing/both `every`/`after`, invalid interval formats, non-APPEND RMV pointing at a replicated (`SharedMergeTree` / `Replicated*`) target (ClickHouse rejects this), and `DEPENDS ON` paired with `REFRESH AFTER`.

  See the [Refreshable materialized views docs](https://chkit.obsessiondb.com/schema/refreshable-views/) for the full reference.

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- b0f200d: **Breaking:** Skip indexes now use a structured discriminated union instead of a free-form `typeArgs: string` field. Each index `type` has its own typed fields, which moves argument validation from runtime to the type system.

  ```ts
  indexes: [
    // before
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      typeArgs: "0",
      granularity: 1,
    },
    // after
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      maxRows: 0,
      granularity: 1,
    },
  ];
  ```

  ### Migration guide

  | Old (`typeArgs`)                               | New (structured)                                                                    |
  | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `type: 'minmax'`                               | `type: 'minmax'`                                                                    |
  | `type: 'set', typeArgs: '0'`                   | `type: 'set', maxRows: 0`                                                           |
  | `type: 'set', typeArgs: '1000'`                | `type: 'set', maxRows: 1000`                                                        |
  | `type: 'bloom_filter'`                         | `type: 'bloom_filter'`                                                              |
  | `type: 'bloom_filter', typeArgs: '0.01'`       | `type: 'bloom_filter', falsePositiveRate: 0.01`                                     |
  | `type: 'tokenbf_v1', typeArgs: '32768, 3, 0'`  | `type: 'tokenbf_v1', sizeBytes: 32768, hashFunctions: 3, randomSeed: 0`             |
  | `type: 'ngrambf_v1', typeArgs: '3, 256, 2, 0'` | `type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0` |

  Highlights:

  - `set` now requires `maxRows` at the type level — forgetting it is a TypeScript error rather than a runtime validation failure.
  - `tokenbf_v1` and `ngrambf_v1` have typed `sizeBytes`, `hashFunctions`, `randomSeed` (and `ngramSize` for ngram), so positional argument mistakes are caught at compile time.
  - `bloom_filter` keeps `falsePositiveRate` optional — omit it to emit a bare `bloom_filter` clause.
  - `chkit pull` now introspects `system.data_skipping_indices.type_full` and emits the structured fields back into schema files; unknown types still round-trip via the existing path.
  - The `index_type_missing_args` validation code is removed since it is now a compile-time concern.

- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.21

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- b0f200d: Add support for per-column compression codecs.

  Declare a codec directly on a column with a structured discriminated union:

  ```ts
  import { codec, table } from "@chkit/core";

  const events = table({
    database: "analytics",
    name: "events",
    columns: [
      { name: "id", type: "UInt64" },
      { name: "ts", type: "DateTime", codec: { kind: "ZSTD", level: 3 } },
      {
        name: "delta",
        type: "Int64",
        codec: [{ kind: "Delta", size: 4 }, { kind: "ZSTD" }],
      },
      { name: "exp", type: "Float32", codec: codec.raw("SomeNewCodec(42)") },
    ],
    engine: "MergeTree()",
    primaryKey: ["id"],
    orderBy: ["id"],
  });
  ```

  Highlights:

  - `CREATE TABLE` and `ALTER TABLE ADD/MODIFY COLUMN` emit the `CODEC(...)` clause in the correct position (after `DEFAULT` and `COMMENT`, as required by ClickHouse).
  - `chkit generate` emits `MODIFY COLUMN ... REMOVE CODEC` when a codec is dropped and no other column fields change; otherwise a single `MODIFY COLUMN` replaces the codec.
  - `chkit pull` introspects `system.columns.compression_codec` and renders structured codec objects back into the schema file. Unknown codec tokens fall back to `codec.raw(...)` so new ClickHouse codecs still round-trip.
  - Canonicalization fills ClickHouse defaults (`ZSTD` → level 1, `LZ4HC` → level 9, `Delta`/`DoubleDelta`/`Gorilla` → size 1), so `{kind:'ZSTD'}` and `{kind:'ZSTD', level:1}` compare equal and the diff engine stays stable across pull → plan round-trips.
  - Validation catches codec chains with more than one general codec, chains that do not end with a general codec, or an empty chain (`codec: []`) — preprocessor alone is accepted since ClickHouse auto-appends the default general codec.
  - `parseCodec` falls back to `raw` when a known codec token has unexpected extra args (e.g. `ZSTD(3, 1)`), so future ClickHouse codec extensions round-trip cleanly through `chkit pull` instead of silently dropping arguments.

- a77c5b2: Add support for ClickHouse refreshable materialized views (RMVs), GA since ClickHouse 24.10.

  Define a refreshable MV by adding a `refresh` field to `materializedView()`:

  ```ts
  const dailyReport = materializedView({
    database: "analytics",
    name: "daily_report_mv",
    to: { database: "analytics", name: "daily_report" },
    refresh: { every: "1 DAY", offset: "2 HOUR" },
    as: "SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day",
  });
  ```

  Supported fields: `every`, `after`, `offset`, `randomize`, `dependsOn`, `settings`, `append`, `empty`.

  Highlights:

  - `chkit generate` emits `ALTER TABLE ... MODIFY REFRESH` for schedule-only changes and `DROP ... SYNC` + `CREATE` for structural changes (added/removed refresh, toggled APPEND).
  - `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that managed ClickHouse environments auto-inject.
  - Validation catches: missing/both `every`/`after`, invalid interval formats, non-APPEND RMV pointing at a replicated (`SharedMergeTree` / `Replicated*`) target (ClickHouse rejects this), and `DEPENDS ON` paired with `REFRESH AFTER`.

  See the [Refreshable materialized views docs](https://chkit.obsessiondb.com/schema/refreshable-views/) for the full reference.

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- b0f200d: **Breaking:** Skip indexes now use a structured discriminated union instead of a free-form `typeArgs: string` field. Each index `type` has its own typed fields, which moves argument validation from runtime to the type system.

  ```ts
  indexes: [
    // before
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      typeArgs: "0",
      granularity: 1,
    },
    // after
    {
      name: "idx_set",
      expression: "source",
      type: "set",
      maxRows: 0,
      granularity: 1,
    },
  ];
  ```

  ### Migration guide

  | Old (`typeArgs`)                               | New (structured)                                                                    |
  | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `type: 'minmax'`                               | `type: 'minmax'`                                                                    |
  | `type: 'set', typeArgs: '0'`                   | `type: 'set', maxRows: 0`                                                           |
  | `type: 'set', typeArgs: '1000'`                | `type: 'set', maxRows: 1000`                                                        |
  | `type: 'bloom_filter'`                         | `type: 'bloom_filter'`                                                              |
  | `type: 'bloom_filter', typeArgs: '0.01'`       | `type: 'bloom_filter', falsePositiveRate: 0.01`                                     |
  | `type: 'tokenbf_v1', typeArgs: '32768, 3, 0'`  | `type: 'tokenbf_v1', sizeBytes: 32768, hashFunctions: 3, randomSeed: 0`             |
  | `type: 'ngrambf_v1', typeArgs: '3, 256, 2, 0'` | `type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0` |

  Highlights:

  - `set` now requires `maxRows` at the type level — forgetting it is a TypeScript error rather than a runtime validation failure.
  - `tokenbf_v1` and `ngrambf_v1` have typed `sizeBytes`, `hashFunctions`, `randomSeed` (and `ngramSize` for ngram), so positional argument mistakes are caught at compile time.
  - `bloom_filter` keeps `falsePositiveRate` optional — omit it to emit a bare `bloom_filter` clause.
  - `chkit pull` now introspects `system.data_skipping_indices.type_full` and emits the structured fields back into schema files; unknown types still round-trip via the existing path.
  - The `index_type_missing_args` validation code is removed since it is now a compile-time concern.

- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.20

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.19

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.18

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.17

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.16

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- a52a2b2: Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.

## 0.1.0-beta.15

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.14

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- bc0c6b1: Fix materialized view drop operations on managed ClickHouse environments (e.g. ObsessionDB) by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.13

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.12

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.11

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.10

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.9

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.8

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.7

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.6

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.5

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.4

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.3

### Patch Changes

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.

## 0.1.0-beta.2

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.

## 0.1.0-beta.1

### Patch Changes

- Rename internals and CLI binary from chkit to chkit.

## 0.1.0-beta.0

### Minor Changes

- Initial beta release of the chkit ClickHouse schema and migration toolkit. Includes the CLI, core schema planner, codegen, ClickHouse client integration, and plugins for pull, typegen, and backfill.
