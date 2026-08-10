# Changelog

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
