# Changelog

## Unreleased

### Added
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

### Fixed
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
