# TypeScript ↔ Python parity matrix

A living document tracking divergences between this Python port and the
upstream TypeScript chkit repository at `packages/`.

The first-base goal was **functional parity for the core CLI surface** —
schema DSL, planner, the five everyday commands (`init` / `generate` /
`migrate` / `status` / `check` / `drift`), and the ClickHouse-backed journal.
Everything in the "Done" column is covered by ported tests (`tests/test_*_parity.py`,
`tests/test_sql_validation_e2e.py`) and verified end-to-end against a live
ClickHouse instance.

The "Deferred" entries are not bugs — they are scope choices for the first
release. Each one has a brief rationale.

## 1:1 with TS (Done)

### Core (`packages/core` → `src/chkit/core/`)

| TS module | Python module | Notes |
|---|---|---|
| `model-types.ts` / `model.ts` | `core/model.py` | Pydantic v2 with `frozen=True`, `extra="forbid"`, discriminated unions for `SchemaDefinition`, `ColumnCodec`, `SkipIndexDefinition`. |
| `canonical.ts` | `core/canonical.py` | Same trimming, sort order, interval upper-casing, `dependsOn`/`settings` sort. |
| `codec.ts` | `core/codec.py` | Same parse/render/canonicalize semantics. Raw fallback identical. |
| `diff-primitives.ts` | `core/diff_primitives.py` | `diff_by_name`, `diff_settings`, `diff_clauses`. |
| `planner.ts` | `core/planner.py` | Same op order, risk classification, rename suggestion logic. |
| `sql.ts` | `core/sql.py` | All `to_create_sql` / `render_alter_*` outputs validated via EXPLAIN AST in `test_sql_validation_e2e.py`. |
| `sql-normalizer.ts` | `core/sql_normalizer.py` | Same engine + fragment normalization. |
| `sql-splitter.ts` | `core/sql_splitter.py` | Statement boundary detection with quote/comment awareness. |
| `key-clause.ts` | `core/key_clause.py` | Top-level comma split for PK/ORDER BY/UNIQUE KEY. |
| `validate.ts` | `core/validate.py` | Same `ValidationIssueCode` set, same error messages. |
| `snapshot.ts` | `core/snapshot.py` | `version: 1`, canonical definitions. |
| `flags.ts` | `core/flags.py` | `parse_flags`, `define_flags`, `UnknownFlagError`, `MissingFlagValueError`. |

### CLI (`packages/cli` → `src/chkit/cli/`)

| TS command | Python | Flags |
|---|---|---|
| `init` | `cli/commands/init.py` | No flags. Writes `clickhouse.config.py` + `src/db/schema/example.py`. |
| `generate` | `cli/commands/generate.py` | `--name`, `--migration-id`, `--dryrun`, `--json`, `--config`. |
| `migrate` | `cli/commands/migrate.py` | `--apply` / `--execute`, `--allow-destructive`, `--json`, `--config`. Plan by default. |
| `status` | `cli/commands/status.py` | `--json`, `--config`. |
| `check` | `cli/commands/check.py` | `--strict`, `--json`, `--config`. |
| `drift` | `cli/commands/drift.py` | `--json`, `--config`. Snapshot-vs-schema only (see deferrals). |

### Migration artifact format

| Surface | Verified parity |
|---|---|
| SQL header (`chkit-migration-format: v1`, `generated-at`, `cli-version`, counts, risk-summary) | Byte-equivalent layout. |
| Per-operation comments (`-- operation: <type> key=<key> risk=<risk>`) | 1:1. |
| Rename hint comments | 1:1. |
| Filename: `<timestamp>_<safe_name>.sql` with `_NNN` collision suffix | 1:1, `safe_name` regex matches. |
| Snapshot file trailing newline | 1:1. |

### Journal store

| Surface | Verified parity |
|---|---|
| Table name `_chkit_migrations` + `CHKIT_JOURNAL_TABLE` env override | 1:1. |
| Schema: `name String, applied_at DateTime64(3,'UTC'), checksum String, chkit_version String, migration_completed Bool, operations Array(Tuple(...))` | 1:1, same column types and order. |
| Engine: `ReplacingMergeTree(applied_at) ORDER BY (name) SETTINGS index_granularity = 1` | 1:1. |
| `ADD COLUMN IF NOT EXISTS` schema upgrade path for old tables | 1:1. |
| `read_journal` query (`FINAL WHERE migration_completed = true ORDER BY name SETTINGS select_sequential_consistency = 1`) | 1:1. |
| Database-missing fallback (catch UNKNOWN_DATABASE on probe) | 1:1. |
| Checksum mismatch detection in `status` / `migrate` / `check` | 1:1. |
| `SYSTEM SYNC REPLICA` best-effort | 1:1. |

### Tests ported

| TS suite (lines) | Python suite | Tests |
|---|---|---|
| `codec.test.ts` (190) | `test_codec_parity.py` | 31 ✓ |
| `flags.test.ts` (120) | `test_flags_parity.py` | 18 ✓ |
| `index.test.ts` (1531) | `test_index_parity.py` | 56 ✓ |
| `sql-validation.e2e.test.ts` (1275) | `test_sql_validation_e2e.py` | 132 ✓ + 2 xfail* |
| — | `test_migration_format.py`, `test_migration_store.py` (port-specific) | 16 ✓ |
| — | originals from initial scaffold | 18 ✓ |
| **Total** | | **271 passed, 2 xfailed** |

\* `xfail` on ClickHouse < 25 for refreshable-MV `APPEND` (server feature not
yet shipped in 24.x). Becomes `xpassed` automatically against a 25+ build or
ObsessionDB.

## Deferred (not 1:1 yet)

Each deferral has a "why" so the next contributor can make the call.

### Plugins (`packages/plugin-*`, `packages/cli/src/runtime/plugin-runtime/`)

| TS plugin | Status | Why deferred |
|---|---|---|
| `@chkit/plugin-codegen` | Not ported | Generates TypeScript types + Zod schemas from definitions. The Python equivalent would emit `pydantic.BaseModel`s + JSON-schema, which is a separate design conversation. |
| `@chkit/plugin-pull` | Not ported | Requires `create-table-parser.ts` (TS-only ClickHouse DDL parser) + introspection client; ~2k lines on its own. |
| `@chkit/plugin-backfill` | Not ported | Time-windowed backfill orchestrator with checkpoints; depends on the plugin runtime. |
| `@chkit/plugin-obsessiondb` | Not ported | Rewrites `Shared*` engines for non-ObsessionDB targets; tightly coupled to TS profile/credentials layer. |

**Runtime hooks not present in Python:** `runOnConfigLoaded`, `runOnSchemaLoaded`,
`runOnPlanCreated`, `runOnCheck`, `runOnCheckReport`, `runPluginCommand`.

### CLI commands

| TS command | Status | Why deferred |
|---|---|---|
| `chkit query` | Not ported | Auxiliary command for ad-hoc SQL via the configured client. Trivial to add when needed; not blocking parity for schema management. |
| `chkit plugin` | Not ported | Inspect / list registered plugins. Only meaningful once plugins exist in Python. |

### Command flags missing in Python

| Command | Flag | Why deferred |
|---|---|---|
| `generate` | `--rename-table`, `--rename-column` | Explicit rename mappings + the `plan-pipeline.ts` / `rename-mappings.ts` machinery (~600 lines). Auto-rename *suggestions* are emitted; explicit overrides are not. |
| `generate` / `migrate` / `check` / `drift` | `--table <selector>` | Table scope filter. Requires the `table-scope.ts` matcher + plan/journal filtering; doable but not on the critical path. |
| `migrate` | Interactive confirm prompts | TS prompts before applying and before running destructive ops. Python currently honours `--apply` / `--allow-destructive` flags only. |

### Drift command

The TS `drift` command additionally compares the snapshot against the live
ClickHouse database (columns, settings, indexes, engine, TTL, partitioning,
projections — see `commands/drift/compare.ts` and `diff.ts`, ~700 lines). The
Python port currently does only the snapshot-vs-current-schema diff, which is
the in-CI use case. The live-DB introspection is the bigger lift since it
requires re-implementing the TS DDL parser.

### Journal store

| TS feature | Status | Why deferred |
|---|---|---|
| Per-operation async tracking (`operations` tuple, `migration_completed=false` for in-flight) | Not used | The Python `migrate` runs synchronously: every statement either succeeds or the migration errors out before the entry is journaled. The columns exist in the table so the schemas match, but Python always inserts `migration_completed=true` and `operations=[]`. |
| Insert race retries (`INSERT race condition` detection) | Not modelled | Race only matters with concurrent appliers; first-base assumes a single applier per project. |

### Config loader

| TS feature | Status | Why deferred |
|---|---|---|
| Async config functions (`(env) => config` or `(env) => Promise<config>`) | Not supported in Python (synchronous only) | Python `clickhouse.config.py` is imported and the `config` attribute is read. Async configs would need a `_resolve_config()` indirection. |
| User profile config (`~/.config/chkit/profile.config.ts`) and credentials layer | Not ported | Allows running `chkit` from outside a project against the ObsessionDB profile. Out of scope for self-hosted ClickHouse users. |
| `chkit obsessiondb login` synthesized profile fallback | Not ported | Coupled to the missing `@chkit/plugin-obsessiondb`. |

### Misc

| TS surface | Status | Why deferred |
|---|---|---|
| `safety-markers.ts` (per-statement risk overrides via SQL comments) | Not ported | Generate already emits risk per op in headers; the override mechanism isn't yet used by core commands. |
| `debug.ts` structured debug logging | Not ported | Python uses Typer's normal stderr; `--json` output handles machine-readable mode. |

## Adding parity for a deferred item

1. Find the TS source file in `packages/cli/src/...` or `packages/plugin-*/src/...`.
2. Port the helper functions / data classes into the equivalent
   `src/chkit/cli/...` or a new `src/chkit/plugin_*` module.
3. Add a parity test under `tests/test_*_parity.py` that mirrors the TS
   `*.test.ts` if one exists, or write a new test that asserts the observable
   behaviour matches the TS docs / source comments.
4. Update this matrix: move the row from "Deferred" to "1:1 with TS (Done)".
5. Bump the version + CHANGELOG entry + publish.
