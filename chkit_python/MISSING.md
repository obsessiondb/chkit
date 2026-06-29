# Features in `chkit` (TypeScript) that are NOT yet in `chkit-py`

Exhaustive audit produced by inventorying every TS file under `packages/` against the
Python port at `chkit_python/src/chkit/`. Generated 2026-06-05 against TS commit on the
local working tree. For each missing feature the table notes:

- **Where in TS** — file path
- **What it does** — one-line behaviour summary
- **Criticality for self-hosted ClickHouse users** — Critical / Useful / Niche / ObsessionDB-only
- **Estimated port effort** — Small (<200 LoC) / Medium (200–600 LoC) / Large (>600 LoC)

The headings are grouped by package. The headline summary at the end of this document
classifies missing items by criticality and sums the rough LoC.

---

## 1. `@chkit/core` (4 missing modules)

| Module | TS path | What it does | Crit | Effort |
|---|---|---|---|---|
| `config-path.ts` | `packages/core/src/config-path.ts` | Sentinel `SYNTHESIZED_CONFIG_PATH` + `isSynthesizedConfigPath()` for synthesized profile configs (no on-disk file). Used by config loader to distinguish "real file" vs "in-memory profile". | Useful | Small (6 LoC) |
| `plugin-error.ts` | `packages/core/src/plugin-error.ts` | `wrapPluginRun({ command, label, jsonMode, print, fn })` — uniform error handling for plugin commands: catches exceptions, formats JSON or human error, returns exit code 1 (error) or 2 (config error). | Useful | Small (~25 LoC) |
| `schema-loader.ts` | `packages/core/src/schema-loader.ts` | `loadSchemaDefinitions(globs, opts)` — generic schema file discovery via `fast-glob` + dynamic module import + `collectDefinitionsFromModule()`. Python port currently has a CLI-layer version only. | Useful | Medium (~80 LoC) |
| `ts-import.ts` | `packages/core/src/ts-import.ts` | Runtime-agnostic dynamic module loader. On Bun: native `import(pathToFileURL)`. On Node: uses `jiti` to transpile `.ts` on the fly. Public API. | Niche (Python loads `.py` directly via importlib, so an equivalent is trivially present but not exported as a named helper) | Small in Python |

### Core deltas in shared modules (already ported, minor differences)

- **`MaterializedViewRefresh`** in TS uses anonymous inline `{database, name}` for `dependsOn`; Python wraps it as `TableRef` model. **Functionally equivalent**; no port action.
- **`MigrationPlan.riskSummary`** in TS is `Record<RiskLevel, number>`; Python wraps it as `_RiskSummary`. **Functionally equivalent**.
- **No missing `ValidationIssueCode`s** — both implementations have the same 13 codes.
- **No missing `MigrationOperationType`s** — both have the same 20 types.

---

## 2. CLI commands (`packages/cli/src/commands/`)

### 2.1 `chkit init` — extended onboarding flags

| Flag | What it does | Crit | Effort |
|---|---|---|---|
| `--yes` / `-y` | Skip the interactive ObsessionDB onboarding; write files silently (CI mode). | Useful | Small |
| `--connect <claim\|account\|clickhouse\|later>` | Pre-select the connect-to-DB choice without prompting. | ObsessionDB-only | Small |
| `--email <email>` | Email for the OTP signup flow. | ObsessionDB-only | Small |
| `--code <code>` | OTP code for signup (CI scriptable). | ObsessionDB-only | Small |
| `--org-name <name>` | Override the auto-derived org name. | ObsessionDB-only | Small |
| Auto dependency install | `ensureProjectDependencies()` runs `npm install` (or equivalent) if `@chkit/core` doesn't resolve. | Niche (Python flow is `pip install chkit-py`, single command, no auto-install). | N/A — convention difference |
| Onboarding dispatch | If TTY + no `--yes`, runs `@chkit/plugin-obsessiondb` `runOnboarding()`. Falls back to static runbook if plugin missing. | ObsessionDB-only | Medium (depends on obsessiondb plugin) |

### 2.2 `chkit generate` — flags + behaviour

| Flag / behaviour | What it does | Crit | Effort |
|---|---|---|---|
| `--rename-table <old_db.old_table:new_db.new_table>` (repeatable) | Explicit table rename mapping. | Useful | Medium |
| `--rename-column <db.table.old_col:new_col>` (repeatable) | Explicit column rename mapping. | Useful | Medium |
| `--table <selector>` | Scope migration to one table or trailing-wildcard prefix (e.g. `events_*`). | Useful | Medium |
| Plugin hooks: `onConfigLoaded`, `onSchemaLoaded`, `onPlanCreated` | Plugins can mutate definitions / plan between steps. | Useful only if plugins exist | Tied to plugin runtime |
| Codegen integration | Auto-invokes `@chkit/plugin-codegen` after each generate if `codegen.runOnGenerate !== false`. | Useful | Tied to codegen plugin |
| Rename mapping pipeline (`plan-pipeline.ts`, `rename-mappings.ts`) | Parses CLI mappings + schema-declared `renamedFrom`, resolves conflicts, applies to plan as rename suggestions, emits `confirmationSQL`. | Useful | Medium (~400 LoC) |

### 2.3 `chkit migrate` — flags + behaviour

| Flag / behaviour | What it does | Crit | Effort |
|---|---|---|---|
| `--table <selector>` | Filter pending migrations to those that touch the matched tables (parses `-- operation:` markers to determine affected tables). | Useful | Medium |
| Interactive confirm prompt | TTY-only: prompts "Apply pending migrations now? [no/yes]:" before executing. | Useful | Small |
| Destructive confirm prompt | TTY-only: prompts "Apply destructive operations? [no/yes]:" with per-op details. | Useful | Small |
| `isBackgroundOrCI()` detection | Auto-detects CI / non-TTY / background and skips prompts. | Useful | Small |
| `applyMigration()` per-statement journaling | Records per-statement state (`OperationState`) in the journal so a partial failure can resume from the last completed statement. | Critical for production safety | Large |
| Async statement execution (`async-apply.ts`) | For long-running `ALTER`s and `OPTIMIZE`s, submits as async query via ClickHouse mutations API and polls until terminal. | Useful | Large |
| `waitForDDLPropagation()` between statements | After each DDL, polls `system.tables` / `system.columns` until the change is visible (needed for ReplicatedMergeTree and ObsessionDB Shared engines). | Critical for replicated targets | Medium |
| Unmarked-destructive detection | Synthesizes "destructive" markers for hand-written SQL (DROP DATABASE/TABLE, ALTER DROP COLUMN, TRUNCATE, DETACH) — defends against migrations not produced by `chkit generate`. | Useful | Medium |
| Exit code 3 on destructive blocked | Distinct from generic exit code 1 to let CI scripts route on it. (Python currently exits 1.) | Small | Small (one-line fix) |
| `extractMigrationMetadata()` `-- log:` header | If a migration has `-- log: <text>` header, it's printed during apply. | Niche | Small |

### 2.4 `chkit status` — extended behaviour

| Behaviour | What it does | Crit | Effort |
|---|---|---|---|
| `--table <selector>` (inherited via GLOBAL_FLAGS) | Filter pending list. Currently Python ignores `--table`. | Useful | Medium |
| `databaseMissing` graceful path | If target DB doesn't exist on the server, displays a warning instead of failing. Python has the path in `journal_store.py` but `status.py` doesn't surface the warning consistently. | Useful | Small |

### 2.5 `chkit check` — full divergence

| Feature | TS | Python |
|---|---|---|
| `--strict` | ✓ enables all policy checks | ✓ (parity) |
| `--table <selector>` scope | ✓ | ✗ |
| `failOnPending` policy | ✓ | ✓ |
| `failOnChecksumMismatch` policy | ✓ | ✓ |
| `failOnDrift` policy | ✓ — evaluates **live DB** drift via `buildDriftPayload` | ✗ Python evaluates **snapshot vs schema** drift only |
| Plugin checks (`onCheck`, `onCheckReport`) | Plugins contribute findings; failed plugin = failed check | ✗ |
| Output: `driftReasonCounts`, `driftReasonTotals` | ✓ in JSON | ✗ |
| Output: `failedChecks` array of category codes | ✓ | partial — Python has a similar list but with simpler categories |

### 2.6 `chkit drift` — the big missing piece

Python implements **snapshot ↔ current schema** diff only. TS implements **snapshot ↔ live ClickHouse**:

| Component | TS path | What it does |
|---|---|---|
| `payload.ts` (146 LoC) | `packages/cli/src/commands/drift/payload.ts` | Builds the full `DriftPayload` — fetches `listSchemaObjects()` and `listTableDetails()` from CH, joins against snapshot, computes drift codes. |
| `compare.ts` (~500 LoC) | `packages/cli/src/commands/drift/compare.ts` | `compareSchemaObjects()` — kind/name set diff; `compareTableShape()` — column-by-column, settings, indexes, projections, TTL, engine, primary key, order by, unique key, partition by. |
| `diff.ts` | `packages/cli/src/commands/drift/diff.ts` | SQL fragment diffing for refining tableDrift output. |

Missing fields in Python output:
- `missing` (objects in snapshot but not in DB)
- `extra` (objects in DB but not in snapshot)
- `kindMismatches` (table ↔ view discrepancy)
- `objectDrift[]` per code
- `tableDrift[]` with `missingColumns / extraColumns / changedColumns / settingDiffs / indexDiffs / ttlMismatch / engineMismatch / primaryKeyMismatch / orderByMismatch / uniqueKeyMismatch / partitionByMismatch / projectionDiffs`
- `databaseMissing` graceful handling

**This is the single biggest CLI gap for users who care about drift detection.** Estimated ~700 LoC port + dependence on `create-table-parser` + introspection.

### 2.7 `chkit plugin` — entire command missing

| Subcommand | What it does |
|---|---|
| `chkit plugin` (no args) | Lists all configured plugins + their commands |
| `chkit plugin <name>` | Lists commands registered by that plugin |
| `chkit plugin <name> <command>` | Dispatches to the plugin's command implementation |

**Only meaningful once Python has a plugin runtime.**

### 2.8 `chkit query` — entire command missing

| Feature | What it does |
|---|---|
| `chkit query "<SQL>"` | Executes SQL against the configured executor (local CH or ObsessionDB remote) |
| Text-mode output | Pretty-aligned table with column headers + row count |
| `--json` output | `ClickHouseJsonQueryResult` envelope (data + meta + statistics) |
| Cleaned error messages | Strips injected `FORMAT JSON` clause; truncates "Expected one of" lists to 8 tokens |
| Multi-positional rejection | Errors if user passes unquoted SQL (`chkit query SELECT 1` → "wrap in quotes") |

Estimated ~200 LoC.

### 2.9 `chkit skills` — entire command missing

Proxy to external `skills` CLI via `npx skills <args>`. Cross-platform (`npx.cmd` on Windows). Exit code propagates from subprocess.

**Niche for Python.** Python equivalent would call `python -m skills` or `pipx run skills` if such a tool existed in the Python ecosystem.

---

## 3. CLI runtime (`packages/cli/src/runtime/`)

The Python port has 5 runtime files (`config_loader.py`, `journal_store.py`, `migration_store.py`, `schema_loader.py`, `main.py`). TS has **22** runtime modules. The missing ones, grouped:

### 3.1 Plugin system (entire subsystem missing)

| Module | LoC | Purpose |
|---|---|---|
| `plugins.ts` | ~300 | All plugin types: `ChxPlugin`, `ChxPluginCommand`, `ChxPluginHooks`, every hook context type. |
| `plugin-runtime/index.ts` | ~250 | `loadPluginRuntime()` — loads, validates, deduplicates plugins; resolves options via Zod-like safeParse; provides command dispatch; injects executor or `NULL_EXECUTOR`. |
| `plugin-runtime/loader.ts` | ~70 | Normalizes registrations, validates manifest (apiVersion=1, CLI version compatibility check). |
| `plugin-runtime/hooks.ts` | ~250 | Runs all 10 hooks (`onInit`, `onComplete`, `onConfigLoaded`, `onSchemaLoaded`, `onPlanCreated`, `onBeforeApply`, `onAfterApply`, `onCheck`, `onCheckReport`, `onBeforePluginCommand`). Threads transformations (definitions, plan, statements) through plugin chain. |
| `plugin-runtime/errors.ts` | ~25 | `formatPluginError()` + `guardHook<T>()` try/catch wrapper. |
| `plugin-runtime/executor-debug.ts` | ~80 | Wraps `ClickHouseExecutor` with `@logtape` tracing when `CHKIT_DEBUG=1`. |
| `plugin-runtime/null-executor.ts` | ~20 | Stub executor that throws on every method except `close()`; used when no ClickHouse config + no plugin provides one. |
| `internal-plugins/index.ts` | ~10 | Aggregates internal plugins (`core`, `skill-hint`). |
| `internal-plugins/core/plugin.ts` | ~25 | Bundles the 7 core commands as a single `core` plugin. |
| `internal-plugins/skill-hint/plugin.ts` | ~100 | Detects AI agents (Claude, Cursor, Copilot, etc.) and prompts for skill install. Cooldown via state file. |
| `internal-plugins/skill-hint/agent-detect.ts` | ~90 | Walks up filesystem looking for `.claude/`, `CLAUDE.md`, `.cursor`, `.cursorrules`, `.github/copilot-instructions.md`, etc. |
| `internal-plugins/skill-hint/prompt.ts` | ~60 | User prompt + install script. |
| `internal-plugins/skill-hint/state.ts` | ~30 | `~/.chkit/skill-hint.json` persistence (lastDismissed timestamp). |

### 3.2 Command dispatch and registry

| Module | LoC | What's missing in Python |
|---|---|---|
| `command-dispatch.ts` | ~290 | `parseCommandArgs()` + `runResolvedCommand()` — TS-specific dispatcher (Python uses Typer instead). Behavioural divergences: query command passes positional args verbatim after `--`, plugin commands strip only known flags. |
| `command-registry.ts` | ~100 | Flattens single-command plugins into top-level commands, nests multi-command plugins under subcommands, merges plugin flag extensions. Not applicable as a direct port (Python uses Typer), but the **flag-merging contract** is missing. |
| `extract-config-path.ts` | ~10 | Pre-parse argv to extract `--config <path>` before full flag parsing (so config can drive flag defs). Python loads config inside each command directly. |
| `global-flags.ts` | ~5 | Declares the three global flags: `--config`, `--json`, `--table`. Python has each as a per-command flag. |
| `help.ts` | ~100 | `formatGlobalHelp()` + `formatCommandHelp()`. Groups commands by core vs plugin, lists subcommands indented, pads columns. Python relies on Typer's auto-generated help. |

### 3.3 Config layering

| Module | LoC | What's missing |
|---|---|---|
| `config-merge.ts` | ~80 | `mergeUserConfig(base, overlay)` — overlay merge with plugin-by-name replacement and clickhouse shallow merge. Used to layer user profile config under project config. |
| `config.ts` | ~250 | Beyond Python's basic config loader: profile layer resolution (`~/.config/chkit/config.ts` > `credentials.json` > synthesized via obsessiondb plugin); enriched error messages with missing-dependency hints; AggregateError unpacking; `resolveDirs()` returning absolute paths. |
| `user-config.ts` | ~12 | `getUserConfigDir()` (XDG-compliant), constants `USER_PROFILE_CONFIG_FILE`, `USER_CREDENTIALS_FILE`. |

### 3.4 JSON output and logging

| Module | LoC | What's missing |
|---|---|---|
| `json-output.ts` | ~85 | `emitJson(command, payload)` — wraps payload in `{schemaVersion, command, ...payload}` envelope. `JsonError` + `JsonErrorEnvelope`. `hasEmittedJson()` guard against double-emit. Python emits raw `json.dumps(payload)` without the envelope. |
| `logging.ts` | ~35 | `configureCliLogging()` — sets up `@logtape` sinks (text format, time-tagged), two loggers (`chkit` debug, `logtape` error). Triggered by `CHKIT_DEBUG=1`. Python uses no structured logging. |
| `debug.ts` | ~16 | Thin `debug(category, message, detail?)` facade over `@logtape`. Used throughout TS code. Python uses no debug calls. |

### 3.5 Safety markers / destructive detection

| Module | LoC | What's missing |
|---|---|---|
| `safety-markers.ts` | ~280 | `scanDestructiveSqlStatements()` (raw SQL pattern match), `collectDestructiveOperationMarkers()` (parses `-- operation: <type> key=... risk=danger` lines for structured info), `collectUnmarkedDestructiveStatements()` (synthesizes warnings for hand-written destructive SQL without markers), `migrationContainsDangerOperation()` (boolean), `extractMigrationOperationSummaries()`, table-recreate detection (drop + create on same key collapses to one warning), `-- before-retry:` parsing. |
| `migration-metadata.ts` | ~25 | `extractMigrationMetadata(sql)` — parses leading `-- key: value` header comments. Currently only `-- log:` is recognized. |

Python's `migrate.py` has a simple `if "risk=danger" in sql_text` check, no structured marker parsing, no unmarked detection, no before-retry, no table-recreate collapse.

### 3.6 Table scope

| Module | LoC | What's missing |
|---|---|---|
| `table-scope.ts` | ~240 | `parseTableSelector()` (supports `<table>`, `<table_prefix*>`, `<database.table>`, validation), `resolveTableScope()` (matches against available tables), `filterPlanByTableScope()` (filters MigrationPlan operations by `table:` / `database:` operation keys, includes rename-mapped old+new tables), `buildScopedSnapshotDefinitions()` (filters snapshot to matched tables for `--table`-scoped generate). |

This is the foundation for **`--table <selector>`** on `generate / migrate / check / drift`.

### 3.7 Dependency bootstrap

| Module | LoC | What's missing |
|---|---|---|
| `deps.ts` | ~90 | `projectHasCoreDependency()`, `detectPackageManager()` (npm/pnpm/yarn/bun), `installCommand()`, `ensureProjectDependencies()` — auto-installs missing deps when scaffolded config can't resolve. **Convention difference** — Python users `pip install chkit-py` explicitly; auto-install is uncommon in Python tooling. |

### 3.8 Version reading

| Module | LoC | What's missing |
|---|---|---|
| `version.ts` | ~6 | `CLI_VERSION` read from `package.json` at runtime. Python reads from `pyproject.toml` (build-time) and exposes `chkit.__version__`. Functionally equivalent. |

### 3.9 Migration store deltas

Python `migration_store.py` + `journal_store.py` cover the basic surface but miss:

| Feature | What's missing |
|---|---|
| `OperationState[]` per migration | TS journals per-statement state in the `operations` tuple column. Python always writes `migration_completed=true, operations=[]`. Required for **resume on partial failure**. |
| `MigrationRowState.migrationCompleted=false` | TS marks a migration in-flight; resume re-reads to determine where to continue. Python has no in-flight state. |
| Per-statement query_id tracking | TS records `query_id` for each statement, enabling async monitoring + cancellation. Python doesn't. |
| INSERT race condition retry (`INSERT race condition detected`) | TS retries the journal insert with exponential backoff (up to 5 attempts). Python attempts once and fails. |
| Schema upgrade path (`ADD COLUMN IF NOT EXISTS`) | TS migrates pre-existing journal tables (predating per-op tracking). Python has the columns in the CREATE statement only, no upgrade path. |
| `_chkit_migrations` project-scoped query | TS filters journal queries to the current project's migration files only — multiple chkit projects can share a database without cross-tenant interference. Python lists everything in the table (showed up in your earlier "Applied: 2" stale-entries bug). |

---

## 4. `@chkit/clickhouse` (entire package mostly missing)

Python `chkit/clickhouse/client.py` is ~80 LoC and exposes only `connect / execute / query / list_databases / list_tables / close`. The TS package is **~1,300 LoC** with much richer surface:

### 4.1 `create-table-parser.ts` (~156 LoC) — DDL parser

**What's missing in Python:** All 8 parser functions for ClickHouse `CREATE TABLE` DDL extraction:

- `parseSettingsFromCreateTableQuery()` — depth-aware split of `SETTINGS k=v, k=v, ...`
- `parseTTLFromCreateTableQuery()`
- `parseEngineFromCreateTableQuery()`
- `parsePrimaryKeyFromCreateTableQuery()`
- `parseOrderByFromCreateTableQuery()`
- `parsePartitionByFromCreateTableQuery()`
- `parseUniqueKeyFromCreateTableQuery()` (CH 23.10+)
- `parseProjectionsFromCreateTableQuery()` — multi-projection block parser

Quote handling: single-quoted strings (with `\'` escape), backtick identifiers. Nested parens tracked. Tolerates missing clauses, missing SETTINGS terminator.

**Required by:** `chkit drift` (live introspection), `chkit pull` (schema reconstruction). **Effort:** Small (~150 LoC).

### 4.2 `ddl-propagation.ts` (~139 LoC) — eventual consistency polling

| Function | What it does |
|---|---|
| `waitForTable(executor, database, table)` | Polls `system.tables` until row appears. |
| `waitForView(executor, database, view)` | Polls for engine `LIKE '%View%'`. |
| `waitForColumn(executor, database, table, column)` | Polls `system.columns`. |
| `waitForTableAbsent(executor, database, table)` | Polls until row disappears (DROP validation). |
| `waitForDDLPropagation(executor, opType, opKey)` | Dispatcher: routes operation type → appropriate waitFor. |

Retry strategy: `p-retry`, 20 attempts × 500ms fixed = ~10s max. **Required by:** `chkit migrate --apply` (ReplicatedMergeTree, Shared engines). **Effort:** Medium (~120 LoC + retry lib).

### 4.3 `index.ts` (~922 LoC) — executor + introspection

| Surface | What's missing |
|---|---|
| `ClickHouseExecutor` interface (13 methods) | Python's `ClickHouseClient` has 6; missing `queryJson`, `insert`, `submit`, `queryStatus`, `listSchemaObjects`, `listTableDetails`. |
| `queryJson()` returning `{data, meta, rows, statistics, query_id}` | Required for `chkit query --json` parity. |
| `insert({table, values, compressed?})` | Helper for typed inserts. |
| `submit(sql, queryId?)` → `query_id` | Async fire-and-forget query submission. Required for backfill and async-apply. |
| `queryStatus(queryId, options?)` → `{status, readRows, readBytes, durationMs, error}` | Polls `system.processes` + `system.query_log`. Required for async-apply + backfill. |
| `listSchemaObjects()` | Enumerates tables/views/MVs across non-system DBs, excludes `_chkit_*`. |
| `listTableDetails(databases)` | Joins `system.tables` + `system.columns` + `system.data_skipping_indices` → `IntrospectedTable[]`. Calls all 8 parser functions. **The critical drift/pull primitive.** |
| `createClickHouseExecutor(config)` (session-bound) | Single `session_id` per HTTP connection, serialized queries — DDL-safe. Python uses default clickhouse-connect behaviour. |
| `createStatelessClickHouseExecutor(config)` | Parallel-safe variant. |
| `inferSchemaKindFromEngine(engine)` | Engine → `'table' \| 'view' \| 'materialized_view'`. |
| `normalizeColumnFromSystemRow(row)` | `system.columns` row → `ColumnDefinition` (handles Nullable, codecs, defaults). |
| `normalizeIndexFromSystemRow(row)` | `system.data_skipping_indices` row → `SkipIndexDefinition` (parses minmax, bloom_filter, tokenbf_v1, ngrambf_v1, set with all arg shapes). |
| `buildIntrospectedTables(tables, columns, indexes)` | Joins rows by `(database, table)`, sorts deterministically. |
| `formatConnectionError(error, url, username?)` | Differentiates auth failure vs network. Python surfaces raw exception. |
| `wrapConnectionError(error, ...)` | Throws formatted error. |
| `isUnknownDatabaseError(error)` | Detects CH error code 81. Python has a string-match equivalent, weaker. |
| `assertStreamedQuerySucceeded(input)` | Checks `x-clickhouse-exception-code` HTTP header (catches errors lost in streaming). |
| `ClickHouseStreamedException` | Custom exception with code, exceptionTag, query_id, SQL preview. |

**Required by:** `pull`, `drift`, `migrate --apply` (async statements), `query`, future backfill. **Effort:** Large (~800 LoC).

### 4.4 `e2e-testkit.ts` (~106 LoC)

Shared E2E test utilities: `getRequiredEnv()` (hard-fails on missing env), `createLiveExecutor()`, `createStatelessLiveExecutor()`, `quoteIdent()`, `createRunTag()`, `createPrefix(label)`, `createJournalTableName(label)` (prefers `GITHUB_RUN_ID`). Python `tests/conftest.py` has a thinner version (only CLICKHOUSE_URL/PASSWORD env + a query client wrapper). **Effort:** Small.

---

## 5. `@chkit/codegen` (entire package missing)

**Note:** This is the older codegen package used by the CLI internally for migration artifact generation. Python ports the file-writing inline in `migration_store.py`. **Functionally already present.**

The newer `@chkit/plugin-codegen` is a separate, user-facing plugin (see §6).

---

## 6. `@chkit/plugin-codegen` (~1,100 LoC, entire plugin missing)

User-facing codegen plugin. Generates TypeScript types + optional Zod schemas + ingest helpers + migration runner from chkit schema definitions.

| Capability | What it produces | Crit |
|---|---|---|
| TypeScript type generation | `export type TableRow = { id: number, ... }` from `TableDefinition[]`. Recursive type resolver for `Nullable()`, `Array()`, `Map()`, `Tuple()`, `SimpleAggregateFunction()`, `LowCardinality()`, `Enum8/16()`, etc. Python equivalent would emit Pydantic `BaseModel`s + JSON Schema. | Critical for Python users who want typed query results |
| Zod runtime schemas | `export const TableRowSchema = z.object({...})` for runtime validation. Python equivalent: leverage Pydantic's runtime validation directly. | Useful |
| Ingest helpers (`emitIngest`) | Per-table `async function ingestTableName(ingestor, rows, options)` with optional Zod validation. | Useful |
| Migration runner (`emitMigrations`) | Embeds `.sql` files as `MigrationEntry[]` and exports `runMigrations(executor, options)` for portable migration application from app code (no CLI dep). | Useful |
| Naming conventions | `PascalCase / camelCase / raw` table-name style; identifier normalization; collision resolution (`_2`, `_3` suffix); JSON-stringify non-identifier column names. | Useful |
| `bigintMode: 'string' \| 'bigint'` | Int64/UInt64 representation choice. Python equivalent: `int` (Python ints are unbounded) or `str` for JSON safety. | Useful |
| `includeViews` | Opt-in view/MV codegen. | Niche |
| Check hook (`onCheck`) | Verifies generated code is up-to-date; emits findings `codegen_missing_output`, `codegen_stale_output`, `codegen_unsupported_type`. | Useful |
| CLI: `chkit codegen [--check] [--out-file PATH] [--emit-zod] [--emit-ingest] [--emit-migrations] ...` | Standalone command. | Useful |
| Errors: `CodegenConfigError`, `UnsupportedTypeError` | Typed errors. | — |

**Estimated Python port effort:** ~3 weeks (Pydantic introspection, recursive type resolver, ingest helpers, migration runner, naming utils, file rendering, check hook).

---

## 7. `@chkit/plugin-pull` (~918 LoC, entire plugin missing)

User-facing pull plugin. Introspects a live ClickHouse / ObsessionDB instance and emits chkit schema files.

| Capability | What it does | Crit |
|---|---|---|
| `chkit schema` CLI subcommand | Triggers the pull workflow. Flags: `--dryrun`, `--force/--overwrite`, `--out-file <path>`, `--database <name>` (repeatable). | Critical |
| Two introspection strategies | Built-in (uses `@chkit/clickhouse` executor) or **custom introspector** (host-provided, used by ObsessionDB plugin to route via API). | Critical |
| Table pulling | Full `IntrospectedTable` spec: columns, indexes, projections, settings, partitioning, TTL, uniqueKey, primaryKey, orderBy. Uses all 8 `parse*` functions from `create-table-parser.ts`. | Critical |
| View pulling | `parseAsClause(query)` — strips `DEFINER` + `SQL SECURITY` clauses; extracts SELECT body verbatim. | Critical |
| Materialized view pulling | `parseToClause()` (target table), `parseRefreshClause()` (REFRESH EVERY/AFTER, OFFSET, RANDOMIZE FOR, DEPENDS ON, SETTINGS, APPEND, EMPTY), `parseAsClause()` (SELECT). | Critical |
| `renderSchemaFile(definitions)` | Renders a `.ts` schema file with `const db_tablename = table({...})` + `export default schema(...)`. Python equivalent: render `.py` file with `table(...)` + `definitions = schema(...)`. | Critical |
| Atomic writes + overwrite safety | Temp file + rename; refuses to overwrite without `--force`. | Useful |
| Determinism | Sorts by database/name; deduplicates variable names with `_2`, `_3` suffix on collision. | Useful |
| Codec rendering on pull | Emits `codec.raw('...')` or structured `{kind: 'ZSTD', level: 3}` based on `parseCodec()` round-trip. | Useful |

**Estimated Python port effort:** ~2 weeks. Easier in Python than TS (regex more readable, no type gymnastics). Output format decision: emit `.py` schema modules using the existing `table()/view()/materialized_view()` factories.

---

## 8. `@chkit/plugin-backfill` (~1,855 LoC, entire plugin missing)

Time-windowed, partition-aware backfill engine with async query submission and checkpointing. **Niche but powerful.**

### 8.1 CLI commands

| Subcommand | What it does |
|---|---|
| `chkit backfill plan` | Build a deterministic backfill plan with partition-aware chunking. |
| `chkit backfill run` | Execute a planned backfill (async query submission + polling). |
| `chkit backfill resume` | Resume from last checkpoint. |
| `chkit backfill status` | Show checkpoint and chunk progress. |
| `chkit backfill cancel` | Cancel an in-progress run. |
| `chkit backfill doctor` | Actionable remediation for failed/pending runs. |
| Many flags | `--from`, `--to`, `--target`, `--max-chunk-bytes`, `--max-parallel-chunks`, `--max-retries-per-chunk`, `--time-column`, `--service-slug`, `--job-id`, etc. |

### 8.2 Chunking strategies

7 strategies, selected adaptively by `strategy-policy.ts` based on sort key type + data distribution:

| Strategy | Sort key | Key idea |
|---|---|---|
| `metadata-single-chunk` | Any | No split; partition already fits |
| `temporal-bucket-split` | DateTime | Group consecutive day/hour buckets |
| `equal-width-split` | Numeric/String | Divide min→max into N equal-width ranges |
| `quantile-range-split` | Numeric/String | Split at percentiles (better for skewed data) |
| `group-by-key-split` | String | Sample top-K distinct values |
| `string-prefix-split` | String | Recursively partition by prefix depth (1-4 chars) |
| `refinement` | Any | Post-process slices with exact `COUNT()` if estimate ratio is suspicious (0.7-1.3) |

### 8.3 Services

| Module | What it does |
|---|---|
| `distribution-source.ts` | Probes data distribution via `GROUP BY day/hour/substring(N)`. |
| `metadata-source.ts` | Parses sort keys from `system.tables`, classifies types. |
| `row-probe.ts` | Estimates rows via `EXPLAIN` or exact `COUNT()`. |

### 8.4 Execution + state

| Module | What it does |
|---|---|
| `async-backfill.ts` (~280 LoC) | Submits chunks as async queries with deterministic IDs (`backfill-{planId}-{chunkId}`); polls status via mutations API; checkpoints to JSON after each state change; concurrent execution; retries with `retryDelayMs` backoff. |
| `state.ts` (~250 LoC) | Persists plan to `{stateDir}/plans/{planId}.json` (immutable) + run to `{stateDir}/runs/{planId}.json` (mutable). Environment fingerprint (SHA256 of `{origin}|{database}`). |
| `check.ts` | Diagnostic hook on `chkit check`; reports `backfill_required_pending`, `backfill_chunk_failed_retry_exhausted`, `backfill_policy_relaxed`. |
| `boundary-codec.ts` | Serialize/deserialize chunk boundaries (hex-latin1 for string sort keys). |

### 8.5 Errors + logging

- `BackfillConfigError` (env/state errors)
- Logger: `getBackfillLogger(...segments)` under `chkit.backfill.*`
- `SLOW_CLICKHOUSE_QUERY_MS` threshold = 5000ms
- Payload formatters: `planPayload()`, `statusPayload()`, `cancelPayload()`, `doctorPayload()`

**Estimated Python port effort:** ~4-6 weeks. Critical core: `async-backfill`, `state`, `planner`, strategies, services. Can defer: `refinement`, `boundary-codec`, full diagnostics.

---

## 9. `@chkit/plugin-obsessiondb` (~2,817 LoC, entire plugin — ObsessionDB-only)

Bridges chkit to managed ObsessionDB cloud instances. **Skip entirely if you only target self-hosted ClickHouse.**

### 9.1 Auth subcommands

| Subcommand | What it does |
|---|---|
| `chkit obsessiondb login` | Device-code auth (RFC 8628). Opens browser, polls until authorized, saves token. |
| `chkit obsessiondb signup` | Passwordless email + 6-digit OTP flow. Modes: interactive (TTY), two-step (CI: `--request-only` then `--code`), scripted. Auto-creates personal org. |
| `chkit obsessiondb logout` | Clears credentials. |
| `chkit obsessiondb whoami` | Show logged-in email + name. |
| Credentials file | `~/.config/chkit/credentials.json` (mode 0600) or `%APPDATA%\chkit\credentials.json`. Default base URL `https://console-api.obsessiondb.com`. |

### 9.2 Service management

| Subcommand | What it does |
|---|---|
| `chkit obsessiondb service list` | List services across all orgs. |
| `chkit obsessiondb service select` | Interactive org/service picker. |
| `chkit obsessiondb service claim` | Claim free dev instance; polls until `running`; auto-selects. |
| `chkit obsessiondb service alias set/list/remove` | Short-name aliases for `--service <alias>` overrides. |

State file: `.chkit/obsessiondb.json` (project) or `~/.config/chkit/obsessiondb.json` (user-global).

### 9.3 Engine rewriting (`onSchemaLoaded` hook)

Auto-converts `Shared*` engines to standard equivalents (`SharedMergeTree → MergeTree`) when targeting non-ObsessionDB ClickHouse. Auto-detects via URL pattern (`obsessiondb.com`, `obsession.numia-dev.com`). Overridable via `--force-shared-engines` / `--no-shared-engines`. Strips cloud-only settings (currently `storage_policy`).

### 9.4 Query remote executor (`getContext` hook)

Replaces local CH connection with `workbench.query.execute()` over oRPC when authenticated + service selected. Implements full `ClickHouseExecutor` interface: `command`, `query<T>`, `queryJson`, `insert`, `submit`, `queryStatus`, `listSchemaObjects`, `listTableDetails`.

### 9.5 Backfill integration

Routes `chkit backfill status / cancel / list` over oRPC to ObsessionDB jobs API. Job statuses: `pending`, `running`, `draining`, `paused`, `completed`, `failed`, `cancelled`. Flags `--service-slug`, `--job-id`, `--local`.

### 9.6 Onboarding (`runOnboarding`)

Interactive menu used by `chkit init` and `create-chkit`: claim dev / login / configure CH / configure later. Includes `ensureObsessiondbPluginInSource()` which text-rewrites the config to add `obsessiondb()` to the plugins array.

### 9.7 oRPC contracts

| Contract | Endpoints |
|---|---|
| `auth/api-client.ts` | requestDeviceCode, pollDeviceToken, getSession, sendVerificationOtp, verifyOtp, createOrganization, setActiveOrganization |
| `contract/jobs.ts` | jobs.submit, jobs.get, jobs.list, jobs.cancel |
| `contract/services.ts` | services.list, services.get, services.claimInstance, services.instanceClaimStatus |
| `contract/workbench.ts` | workbench.query.execute |

**Estimated Python port effort:** ~6-8 weeks (entire plugin + oRPC client). Skip for self-hosted-only users.

---

## 10. `create-chkit` (~543 LoC, entire scaffolder missing)

Standalone `bun create chkit@latest` / `npm create chkit` tool. Downloads example projects from GitHub and runs init.

| Capability | What it does | Crit for Python |
|---|---|---|
| Interactive prompts | `@clack/prompts` for project name, example pick, package manager. | Useful (Python: `python -m chkit init` already covers this) |
| Example download from GitHub | `downloadExample(example: string)` — supports named examples or full GitHub URLs. | Useful |
| Package manager detection | `detectPackageManager()` — npm/pnpm/yarn/bun. | N/A for Python |
| Auto-install via PM | `runInstall()`. | N/A for Python |
| `--example`, `--package-manager`, `--skip-install`, `--skip-onboarding`, `--connect`, `--email`, `--code`, `--org-name` | Same flag set as `chkit init`. | Useful |
| ObsessionDB onboarding integration | Calls `runOnboarding()` from plugin. | ObsessionDB-only |
| `transform-pkg.ts` | Rewrites `package.json` (name, scripts) post-download. | N/A for Python |

**Python equivalent options:**
- A `cookiecutter-chkit` repo (popular Python convention).
- A `python -m chkit_examples` command bundled with `chkit-py[examples]` extra.
- Currently Python has `chkit init` which scaffolds a minimal project but doesn't download from a curated examples gallery.

**Not a critical gap** — Python convention favours one-command install + minimal scaffold. The curated examples gallery is the missing piece if/when chkit-py grows enough to warrant one.

---

## Headline summary

### By criticality (for self-hosted ClickHouse users, ObsessionDB excluded)

**Critical (blocks common workflows):**

- `chkit drift` against live DB (~700 LoC) — currently snapshot-only
- `create-table-parser.ts` (~150 LoC) — required by drift and pull
- `chkit pull` / `chkit schema` plugin (~900 LoC) — schema → file generation
- `@chkit/clickhouse` introspection: `listSchemaObjects`, `listTableDetails`, executor JSON methods (~800 LoC)
- `--table <selector>` scope on generate/migrate/check/drift (~250 LoC)
- `waitForDDLPropagation()` for replicated/Shared engines (~120 LoC)
- Per-statement journal state for resume-on-failure (~200 LoC)
- Async statement execution (`async-apply`, `submit`, `queryStatus`) (~300 LoC)

**Useful (improves UX or covers edge cases):**

- `--rename-table` / `--rename-column` mappings + pipeline (~400 LoC)
- Plugin runtime + hooks system (~750 LoC) — only if you intend to support plugins
- Interactive prompts for `migrate` (~80 LoC)
- Destructive scan for hand-written SQL (`safety-markers.ts`) (~280 LoC)
- `chkit query` command (~200 LoC)
- `@chkit/plugin-codegen` Pydantic emit (~1,100 LoC)
- `chkit check` plugin-driven findings (depends on plugin runtime)
- `config-merge.ts` profile layering (~80 LoC)
- `json-output.ts` envelope (`schemaVersion`, `command`, ...payload) (~85 LoC)
- `migration-metadata.ts` `-- log:` header (~25 LoC)
- `--service` / `--force-shared-engines` extended flags (only useful with obsessiondb plugin)

**Niche:**

- `chkit skills` proxy command
- `internal-plugins/skill-hint/*` AI-agent detection + prompts (~280 LoC)
- `deps.ts` auto-install (Python convention different)
- `ts-import.ts` (Python uses importlib directly)
- `core/config-path.ts` synthesized-path sentinel (only meaningful with obsessiondb)
- `core/plugin-error.ts` wrapper (~25 LoC) — small, could be added cheaply

**ObsessionDB-only (skip if self-hosted):**

- Entire `@chkit/plugin-obsessiondb` (~2,800 LoC) — auth, services, claim, remote executor, backfill routing, onboarding wizard, oRPC contracts
- `create-chkit` ObsessionDB onboarding paths

**Backfill (niche but powerful):**

- Entire `@chkit/plugin-backfill` (~1,855 LoC) — 7 chunking strategies, async execution engine, checkpoint state, doctor diagnostics

### Total LoC outstanding

| Bucket | Approx LoC |
|---|---|
| Critical | ~3,400 |
| Useful | ~2,300 |
| Niche | ~500 |
| Plugin-codegen | ~1,100 |
| Plugin-pull | ~900 |
| Plugin-backfill | ~1,855 |
| Plugin-obsessiondb | ~2,800 |
| **Grand total** | **~12,855 LoC** |

For comparison, current `chkit-py` is ~3,200 LoC of `src/` + ~3,500 LoC of `tests/`.

### Recommended port order (for self-hosted users)

1. **`create-table-parser.ts`** — enables everything downstream.
2. **`@chkit/clickhouse` introspection** (`listSchemaObjects`, `listTableDetails`, `inferSchemaKindFromEngine`, `normalizeColumnFromSystemRow`, `normalizeIndexFromSystemRow`).
3. **`drift compare.ts` + `payload.ts`** — full live-DB drift.
4. **`@chkit/plugin-pull` equivalent** (renders `.py` schema files).
5. **`table-scope.ts`** + `--table` flag on generate/migrate/check/drift.
6. **`waitForDDLPropagation()`** in migrate.
7. **`@chkit/plugin-codegen` equivalent** (Pydantic + JSON Schema emit).
8. **Async statement execution** + per-statement resume.
9. **Rename mappings** (`--rename-table`, `--rename-column`).
10. **`safety-markers.ts`** unmarked-destructive detection.
11. **`chkit query`** command.
12. **Plugin runtime** (only if/when other plugins ship in Python).
13. **`chkit backfill`** (most users won't need this).
14. **`@chkit/plugin-obsessiondb`** (only if ObsessionDB integration is in scope).

---

## How this audit was produced

Six parallel `Explore` agents read every `.ts` file under `packages/` and cross-referenced
each export, flag, hook, and output field against the Python files at
`chkit_python/src/chkit/`. See conversation history (2026-06-05) for the raw agent
outputs that informed each section above.
