# chkit

## 0.1.2-beta.0

### Patch Changes

- 5a8d805: Support ClickHouse function expressions in `primaryKey`/`orderBy` (e.g. `toDate(ts)`, `toStartOfHour(session_end)`). Validation no longer reports `primary_key_missing_column`/`order_by_missing_column` for expression entries, and generated DDL emits them verbatim instead of quoting the whole expression as a column name. Plain column references are still validated and backtick-quoted as before.

  Migration planning now compares key clauses independent of insignificant whitespace and identifier backtick-quoting, so an expression written as `toStartOfHour( ts )` or a column written bare as `user-id` no longer diffs against ClickHouse's normalized `toStartOfHour(ts)` / `` `user-id` `` and triggers a phantom table recreate on `migrate`/`drift`/`check`.

- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.0
  - @chkit/clickhouse@0.1.2-beta.0
  - @chkit/codegen@0.1.2-beta.0

## 0.1.1

### Patch Changes

- 6b87e6d: Add ClickHouse cluster support. Set `clickhouse.cluster` in your config to run all generated DDL `ON CLUSTER <name>` and store the migration journal in a replicated engine — for self-managed multi-node clusters. Your table engines are passed through unchanged (declare `ReplicatedMergeTree` yourself). Leave `cluster` unset for single-node, ClickHouse Cloud, or ObsessionDB, where replication is automatic and `ON CLUSTER` is unnecessary.
- Updated dependencies [6b87e6d]
  - @chkit/core@0.1.1
  - @chkit/clickhouse@0.1.1
  - @chkit/codegen@0.1.1

## 0.1.0

### Patch Changes

- 2f1767f: Add debug logging via `CHKIT_DEBUG=1` environment variable. Logs config loading, command dispatch, plugin lifecycle hooks, ClickHouse queries with timing, journal operations, and per-command details to stderr.
- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- f4e5a59: Replace the leaked ClickHouse server blurb on an authentication failure with a single clear line. A wrong `CLICKHOUSE_PASSWORD` previously dumped ~8 lines of ClickHouse Cloud password-reset instructions and `/etc/clickhouse-server/users.d/` filesystem paths that read as an internal error leak. chkit now detects auth failures (ClickHouse error codes 194/516, `REQUIRED_PASSWORD`/`AUTHENTICATION_FAILED`, or an "Authentication failed" message) and reports: `Authentication failed for user "<user>" at <url>. Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD.`
- bb62cd0: Add a `chkit skills` command that proxies to the external `skills` CLI (e.g. `chkit skills add obsessiondb/chkit` runs `npx skills add obsessiondb/chkit`). The agent skill is installed by the separate `skills` tool, not a chkit subcommand, so users who reached for `chkit skills add …` previously hit "Unknown command: skills". The command forwards its arguments and passes through the underlying exit code, and is handled before config loading so it works without a project.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- 500b7ba: Add the `create-chkit` package, a scaffolder that downloads a curated example from the chkit repository (default: `clickbench`) into a new project directory, rewrites `chkit` and `@chkit/*` dependency versions to `latest`, and runs install with the detected package manager. Restructure the Getting Started docs into two pages — "Start with an example" (using `create-chkit`) and "Add to an existing project" (using `chkit init`) — and update the docs URL printed by `chkit init` to point to the new page.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- 95e6dbb: Detect ClickHouse exceptions that arrive in the `x-clickhouse-exception-code` response header on an HTTP 200 response. When `send_progress_in_http_headers=1` is set (chkit's default for long-running migrations), ClickHouse commits to a 200 status before the query completes; if the query then errors, the exception is reported via response headers rather than as an HTTP error code. `@clickhouse/client` does not surface this as a thrown error, so previously `chkit migrate` could record a failed INSERT migration as applied while the data never landed.

  `@chkit/clickhouse` now inspects `result.response_headers` after every `command`/`query`/`queryJson`/`insert` call and throws a new `ClickHouseStreamedException` (with `code`, `exceptionTag`, and `query_id`) when a non-zero exception code is present. Migrations that fail this way now exit with a non-zero status and remain pending so the operator can fix the underlying issue and re-apply.

- ff1cd31: Stop reporting unmanaged tables as drift by default. On a shared database, every object chkit doesn't manage was emitted as `extra_object` and set `drifted = true`, so `drift` always reported drift and `check` (which defaults to `failOnDrift: true`) failed the CI gate permanently for unrelated reasons. Objects that exist in ClickHouse but are not in your schema are now reported for visibility but no longer count as drift. A new `check.failOnExtraObjects` option (default `false`) opts back into treating them as drift, for when chkit owns the entire database.
- 0df9666: Clearer errors when things go wrong:

  - A rejected migration now reports the migration file, the failed statement's position (e.g. "statement 2 of 3"), and a SQL preview, alongside the ClickHouse message — instead of a bare exception with no context.
  - A syntax error in `clickhouse.config.ts` now prints the actual build diagnostics (each underlying error), instead of only the "N errors building config.ts" summary.
  - Documented the column `codec` API (general/preprocessor/raw codecs, chains, and the codec-chain validation rules) in the schema DSL reference.

- d9d5038: Polish error messages and a few noisy outputs:

  - A table defined with `orderBy` but no `primaryKey` no longer crashes with a raw `TypeError`; the primary key defaults to the order-by columns, matching ClickHouse.
  - Built-in command errors (e.g. a rejected migration) surface their own clean message instead of being wrapped in `Plugin "core" failed in ...`.
  - `chkit query` syntax errors no longer leak the injected `FORMAT JSON` clause the user never typed, and the "Expected one of" token dump is capped.
  - Connection errors whose reason is only in the message (no `.code`) — e.g. a typo'd host — are now recognized and cleaned instead of leaking the raw client string.
  - The post-apply message names the resolved journal table (respecting `CHKIT_JOURNAL_TABLE`) instead of a hardcoded `_chkit_migrations`.
  - The ObsessionDB "authenticated but no service selected" reminder is suppressed when a direct `clickhouse` target is configured (it was layered in from a global login, not chosen for the project).

- ca968d9: Fix stale internal dependency pins in published packages. `chkit` shipped with `@chkit/plugin-obsessiondb` pinned one version behind because the publish step only resolved `workspace:` specifiers in `dependencies`/`devDependencies`, skipping `optionalDependencies` (where the plugin is declared) — so the CLI bundled an outdated plugin and every `chkit query` failed with `serviceSlug is required`.

  The publish resolver now covers every dependency field, `@chkit/codegen` uses `workspace:*` for `@chkit/core` instead of an exact pin, and two release guards (source-side `check:workspace-deps` and packed-tarball `check:packed-deps`) fail the build if any publishable package would ship a stale or unresolved internal dependency.

- 99136de: Fix `migrate --apply` crashing against an ObsessionDB-managed service. The ObsessionDB workbench API returns every column value as a string, so the migration journal's `operations` (`Array(Tuple)`) column arrived as text and `migration_completed` arrived as `"true"`/`"false"` — causing `(row.operations ?? []).map is not a function` and a `Boolean("false") === true` mis-read. The journal now reads `operations` via `toJSONString(...)` + `JSON.parse` and parses the boolean explicitly, which round-trips identically through both the native ClickHouse client and the remote executor (no journal schema change).
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 8d5878a: Generate idempotent `RENAME COLUMN` / `RENAME TABLE` statements using `IF EXISTS`. Renames are the one non-idempotent generated DDL: replaying `RENAME COLUMN a TO b` after it already ran fails with "unknown identifier". With `IF EXISTS`, a replay after a partial migration failure (or alongside per-statement resume) is a safe no-op instead of bricking the migration. Applies to both auto-detected rename suggestions and explicit `--rename-column` / `--rename-table` / `renamedFrom` renames.
- 713176e: `chkit init` now auto-installs `chkit`, `@chkit/core`, and `@chkit/plugin-obsessiondb` when the project has no dependencies, so a fresh `init` into an empty directory produces a runnable project instead of dead-ending on unresolved config imports at the first `generate`. Detects the package manager from `npm_config_user_agent` (defaults to bun), writes a minimal `package.json` if absent, and degrades to printing the manual install command if the install fails.
- bb62cd0: Make `chkit init` consistent with `create-chkit` for connecting a database, and stop hiding plugin import failures. In a non-TTY shell `init` now prints the same connect runbook `create-chkit` does (when the obsessiondb plugin is installed) instead of silently skipping it; `--yes` still keeps init a silent file-writer for CI. The dynamic plugin import now only degrades silently when the plugin is genuinely not installed — any other load failure propagates instead of a false silent pass. The static next-steps also use `npx` rather than a hardcoded `bunx`.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- 1af6ef6: Emit a stable JSON error envelope in `--json` mode. Previously any failure left stdout empty and printed a multi-line plain-text message to stderr, so any pipe to `jq` broke on the first error. Failures now write `{ "command", "schemaVersion", "ok": false, "error": { "code", "message", "hint?" } }` to stdout (exit code unchanged). Successful `--json` output is unchanged. Commands that already emit a structured JSON payload before failing (e.g. checksum mismatch, blocked destructive migration) are not double-wrapped.
- bb62cd0: Keep polling an async data-load migration through transient gateway errors instead of aborting. A single HTTP 524 (or other transient failure) on a status-poll request no longer cancels the migration: the server-side query keeps running, so chkit tolerates a bounded number of poll errors and only gives up after the budget, with an explicit message that the load may still be running and that re-running re-attaches via the deterministic `query_id`. Only a real query exception, or a submit-time failure, is fatal. This affects only operations marked `mode=async` (data loads); ordinary schema DDL is synchronous and unaffected.
- 500b7ba: Add a `-- log: <message>` metadata key to migration files. When set, the message is printed to stdout immediately before the migration is applied, so operators see context for long-running or otherwise-noteworthy migrations (e.g. "Loading 100M rows, ~3-5 min"). Parsed from the leading `-- key: value` comment block; unknown keys are ignored so future additions stay backwards-compatible.
- 5a62874: Add `mode=async` annotation for long-running migration operations.

  Mark an operation as async by adding `mode=async` to its `-- operation:` header line, for example:

  ```sql
  -- operation: load_table_data key=table:default.hits risk=caution mode=async
  INSERT INTO default.hits SELECT * FROM s3(...);
  ```

  When `chkit migrate --apply` encounters an async operation it:

  1. Computes a deterministic `query_id` from `sha256(migration_filename + ':' + statement_index)`.
  2. Checks `system.processes` / `system.query_log` for any prior attempt with that id.
  3. Fires the INSERT via the existing `submit()` path without blocking on its HTTP response, and polls `queryStatus(query_id)` every 5 seconds — printing a one-line update (`written=N.NM rows (N.N GiB), elapsed Ns`) so the operator sees the load advance.
  4. On `QueryFinish` → records the journal entry and proceeds. On `ExceptionWhileProcessing` → throws with the server's exception. On any prior run's failure → resubmits (retry semantics).

  This unblocks two scenarios chkit could not previously handle:

  - **Long INSERTs through a proxy/LB with an HTTP request-duration ceiling**: the operator sees progress, and a connection drop mid-poll no longer cancels the work — the deterministic id lets a re-run attach to the in-flight query on the server.
  - **Transient client-side errors during a multi-minute load**: re-running chkit picks up where it left off rather than starting over.

  Existing migrations without `mode=async` continue to use the synchronous path; the annotation is opt-in and forward-compatible (an unknown mode value falls back to sync).

- 5ee4afc: Order materialized-view creates by their `refresh.dependsOn` edges. Creates within the same kind were tie-broken purely by name, so a refreshable materialized view declared `DEPENDS ON other_mv` whose name sorted before its dependency could be created first and fail. The planner now creates a `DEPENDS ON` target before the view that depends on it; independent views keep their stable alphabetical order.
- bb62cd0: Make `--json` always emit a JSON object, never a bare JSON-encoded string. `printOutput` now wraps any plain string printed under `--json` in `{ schemaVersion, message }`, closing the whole class of bug at the serializer so no command can leak a bare string. `chkit obsessiondb whoami` gains a structured envelope (`status: logged_in | not_logged_in | session_expired`), and `chkit obsessiondb service list` emits a single object with a `services[]` array instead of one JSON line per service (which was not valid single-JSON). Previously these commands `JSON.stringify`'d a prose string (e.g. `"Not logged in…"`), breaking any pipe to `jq`. Text-mode output is unchanged. Note: this changes the `--json` output shape of `whoami` and `service list` from a string to an object.
- 99136de: Add ObsessionDB onboarding to `chkit init` and `create-chkit`: a 3-way "how do you want to connect?" prompt covering an existing ClickHouse instance, an existing ObsessionDB account, and claiming a free ObsessionDB dev instance. Adds passwordless CLI signup (`chkit obsessiondb signup`, email + one-time code) with automatic personal-org creation, and `chkit obsessiondb service claim` to claim and provision a free instance, then write a ready-to-use connection.

  Non-interactive callers (agents/CI) now get a full runbook instead of dead-end prompts: when no TTY is detected, onboarding prints every connect path as runnable commands, and `signup` supports a two-step OTP flow — `--request-only` sends the code and prints the exact follow-up command, then `--email --code <CODE>` verifies without re-sending (which would otherwise invalidate the code). When an explicit connect path is requested but cannot complete (e.g. `--connect claim` with no email, or a bad code), `chkit init` and `create-chkit` now exit non-zero instead of falling through to "next steps" with a success status, so scripts can detect the failure.

- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- 75bf348: Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

  Notes:

  - The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
  - The remote backfill flag `--service-id` is renamed to `--service-slug`.

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

- f1066a6: Add `onBeforePluginCommand` hook allowing plugins to intercept other plugins' commands.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- fea565c: `chkit migrate` now flags a destructive table **recreate** (a `DROP TABLE` + `CREATE TABLE` caused by changing `engine`, `orderBy`, `primaryKey`, `partitionBy`, or `uniqueKey`) with a distinct `table_recreate_data_loss` warning instead of the generic `drop_table_data_loss`. The warning spells out that all rows are permanently deleted and the table is recreated empty, and recommends migrating via a temporary table to preserve data. Documented in the migrate and schema DSL reference pages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 2b51cfc: Scan the executable SQL of migrations for hand-written destructive statements, not just planner-emitted safety markers. A destructive statement (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DROP VIEW`/`DROP MATERIALIZED VIEW`, `DETACH`, or `DROP DATABASE`) with no `-- operation:` marker — whether the whole migration was hand-written or the statement was hand-appended to a generated one — was previously applied silently in non-interactive/CI runs, causing irreversible data loss. Such statements now require `--allow-destructive` (or `safety.allowDestructive`) like any other destructive operation. Planner-marked statements keep their existing risk classification (generated migrations emit one marker per statement), so a planner-approved non-danger operation such as a materialized-view recreate is not blocked. Commented-out statements are ignored (comments are stripped before scanning).
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 62652d8: `status` now reports `Applied` scoped to migrations present in your project's migrations directory, rather than a global count from the journal table. On a shared ObsessionDB journal this previously counted other tenants' rows and could show `Applied` greater than `Total`.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 8d5878a: Resume partially-applied synchronous (DDL) migrations instead of replaying from the first statement. Previously, if a multi-statement migration failed partway (e.g. statement 1 added a column, statement 2 failed), nothing was journaled and re-running replayed statement 1 — which then failed with "column already exists", leaving the migration permanently stuck with the database mutated. Sync statements now record per-statement journal state (`started` → `completed`/`failed`), mirroring the async path: completed statements are skipped on re-run so the migration resumes from where it failed. Resuming across a migration-file edit is refused (checksum guard).
- 6789850: `migrate --table` no longer silently skips hand-written migrations that have no `-- operation:` markers. Their target tables can't be determined, so they are now fail-safe **included** (rather than dropped, which left pending work unapplied while appearing successful) and reported — with a warning in human output and an `undeterminedMigrations` array in `--json` output.
- 0aa2c28: Load `.ts` config and schema files under plain Node, not only Bun. Previously every database command (`status`, `generate`, `migrate`, `check`, `drift`, `query`) failed on Node with `Unknown file extension ".ts"`, despite the docs advertising Node.js 20+. Config and schema modules now load through jiti on Node (and continue to use Bun's native importer under Bun). Also improves the cold-start error when a config can't resolve its dependencies: instead of a raw module-resolution error, chkit now reports which package is missing and tells you to run `bun install` (or `npm`/`pnpm install`).
- dfaa8fa: Document the pre-1.0 versioning, channel, and support policy in the chkit README, and lock-step all publishable packages into a single changesets fixed group so versions never skew across packages.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [f4e5a59]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [95e6dbb]
- Updated dependencies [ff1cd31]
- Updated dependencies [d9d5038]
- Updated dependencies [ca968d9]
- Updated dependencies [a94a2a1]
- Updated dependencies [17b8a27]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [8d5878a]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [5ee4afc]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [72c3fdd]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [0aa2c28]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0
  - @chkit/clickhouse@0.1.0
  - @chkit/codegen@0.1.0

## 0.1.0-beta.29

### Patch Changes

- 2f1767f: Add debug logging via `CHKIT_DEBUG=1` environment variable. Logs config loading, command dispatch, plugin lifecycle hooks, ClickHouse queries with timing, journal operations, and per-command details to stderr.
- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- f4e5a59: Replace the leaked ClickHouse server blurb on an authentication failure with a single clear line. A wrong `CLICKHOUSE_PASSWORD` previously dumped ~8 lines of ClickHouse Cloud password-reset instructions and `/etc/clickhouse-server/users.d/` filesystem paths that read as an internal error leak. chkit now detects auth failures (ClickHouse error codes 194/516, `REQUIRED_PASSWORD`/`AUTHENTICATION_FAILED`, or an "Authentication failed" message) and reports: `Authentication failed for user "<user>" at <url>. Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD.`
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- 500b7ba: Add the `create-chkit` package, a scaffolder that downloads a curated example from the chkit repository (default: `clickbench`) into a new project directory, rewrites `chkit` and `@chkit/*` dependency versions to `latest`, and runs install with the detected package manager. Restructure the Getting Started docs into two pages — "Start with an example" (using `create-chkit`) and "Add to an existing project" (using `chkit init`) — and update the docs URL printed by `chkit init` to point to the new page.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- 95e6dbb: Detect ClickHouse exceptions that arrive in the `x-clickhouse-exception-code` response header on an HTTP 200 response. When `send_progress_in_http_headers=1` is set (chkit's default for long-running migrations), ClickHouse commits to a 200 status before the query completes; if the query then errors, the exception is reported via response headers rather than as an HTTP error code. `@clickhouse/client` does not surface this as a thrown error, so previously `chkit migrate` could record a failed INSERT migration as applied while the data never landed.

  `@chkit/clickhouse` now inspects `result.response_headers` after every `command`/`query`/`queryJson`/`insert` call and throws a new `ClickHouseStreamedException` (with `code`, `exceptionTag`, and `query_id`) when a non-zero exception code is present. Migrations that fail this way now exit with a non-zero status and remain pending so the operator can fix the underlying issue and re-apply.

- ff1cd31: Stop reporting unmanaged tables as drift by default. On a shared database, every object chkit doesn't manage was emitted as `extra_object` and set `drifted = true`, so `drift` always reported drift and `check` (which defaults to `failOnDrift: true`) failed the CI gate permanently for unrelated reasons. Objects that exist in ClickHouse but are not in your schema are now reported for visibility but no longer count as drift. A new `check.failOnExtraObjects` option (default `false`) opts back into treating them as drift, for when chkit owns the entire database.
- 0df9666: Clearer errors when things go wrong:

  - A rejected migration now reports the migration file, the failed statement's position (e.g. "statement 2 of 3"), and a SQL preview, alongside the ClickHouse message — instead of a bare exception with no context.
  - A syntax error in `clickhouse.config.ts` now prints the actual build diagnostics (each underlying error), instead of only the "N errors building config.ts" summary.
  - Documented the column `codec` API (general/preprocessor/raw codecs, chains, and the codec-chain validation rules) in the schema DSL reference.

- d9d5038: Polish error messages and a few noisy outputs:

  - A table defined with `orderBy` but no `primaryKey` no longer crashes with a raw `TypeError`; the primary key defaults to the order-by columns, matching ClickHouse.
  - Built-in command errors (e.g. a rejected migration) surface their own clean message instead of being wrapped in `Plugin "core" failed in ...`.
  - `chkit query` syntax errors no longer leak the injected `FORMAT JSON` clause the user never typed, and the "Expected one of" token dump is capped.
  - Connection errors whose reason is only in the message (no `.code`) — e.g. a typo'd host — are now recognized and cleaned instead of leaking the raw client string.
  - The post-apply message names the resolved journal table (respecting `CHKIT_JOURNAL_TABLE`) instead of a hardcoded `_chkit_migrations`.
  - The ObsessionDB "authenticated but no service selected" reminder is suppressed when a direct `clickhouse` target is configured (it was layered in from a global login, not chosen for the project).

- ca968d9: Fix stale internal dependency pins in published packages. `chkit` shipped with `@chkit/plugin-obsessiondb` pinned one version behind because the publish step only resolved `workspace:` specifiers in `dependencies`/`devDependencies`, skipping `optionalDependencies` (where the plugin is declared) — so the CLI bundled an outdated plugin and every `chkit query` failed with `serviceSlug is required`.

  The publish resolver now covers every dependency field, `@chkit/codegen` uses `workspace:*` for `@chkit/core` instead of an exact pin, and two release guards (source-side `check:workspace-deps` and packed-tarball `check:packed-deps`) fail the build if any publishable package would ship a stale or unresolved internal dependency.

- 99136de: Fix `migrate --apply` crashing against an ObsessionDB-managed service. The ObsessionDB workbench API returns every column value as a string, so the migration journal's `operations` (`Array(Tuple)`) column arrived as text and `migration_completed` arrived as `"true"`/`"false"` — causing `(row.operations ?? []).map is not a function` and a `Boolean("false") === true` mis-read. The journal now reads `operations` via `toJSONString(...)` + `JSON.parse` and parses the boolean explicitly, which round-trips identically through both the native ClickHouse client and the remote executor (no journal schema change).
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 8d5878a: Generate idempotent `RENAME COLUMN` / `RENAME TABLE` statements using `IF EXISTS`. Renames are the one non-idempotent generated DDL: replaying `RENAME COLUMN a TO b` after it already ran fails with "unknown identifier". With `IF EXISTS`, a replay after a partial migration failure (or alongside per-statement resume) is a safe no-op instead of bricking the migration. Applies to both auto-detected rename suggestions and explicit `--rename-column` / `--rename-table` / `renamedFrom` renames.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- 1af6ef6: Emit a stable JSON error envelope in `--json` mode. Previously any failure left stdout empty and printed a multi-line plain-text message to stderr, so any pipe to `jq` broke on the first error. Failures now write `{ "command", "schemaVersion", "ok": false, "error": { "code", "message", "hint?" } }` to stdout (exit code unchanged). Successful `--json` output is unchanged. Commands that already emit a structured JSON payload before failing (e.g. checksum mismatch, blocked destructive migration) are not double-wrapped.
- 500b7ba: Add a `-- log: <message>` metadata key to migration files. When set, the message is printed to stdout immediately before the migration is applied, so operators see context for long-running or otherwise-noteworthy migrations (e.g. "Loading 100M rows, ~3-5 min"). Parsed from the leading `-- key: value` comment block; unknown keys are ignored so future additions stay backwards-compatible.
- 5a62874: Add `mode=async` annotation for long-running migration operations.

  Mark an operation as async by adding `mode=async` to its `-- operation:` header line, for example:

  ```sql
  -- operation: load_table_data key=table:default.hits risk=caution mode=async
  INSERT INTO default.hits SELECT * FROM s3(...);
  ```

  When `chkit migrate --apply` encounters an async operation it:

  1. Computes a deterministic `query_id` from `sha256(migration_filename + ':' + statement_index)`.
  2. Checks `system.processes` / `system.query_log` for any prior attempt with that id.
  3. Fires the INSERT via the existing `submit()` path without blocking on its HTTP response, and polls `queryStatus(query_id)` every 5 seconds — printing a one-line update (`written=N.NM rows (N.N GiB), elapsed Ns`) so the operator sees the load advance.
  4. On `QueryFinish` → records the journal entry and proceeds. On `ExceptionWhileProcessing` → throws with the server's exception. On any prior run's failure → resubmits (retry semantics).

  This unblocks two scenarios chkit could not previously handle:

  - **Long INSERTs through a proxy/LB with an HTTP request-duration ceiling**: the operator sees progress, and a connection drop mid-poll no longer cancels the work — the deterministic id lets a re-run attach to the in-flight query on the server.
  - **Transient client-side errors during a multi-minute load**: re-running chkit picks up where it left off rather than starting over.

  Existing migrations without `mode=async` continue to use the synchronous path; the annotation is opt-in and forward-compatible (an unknown mode value falls back to sync).

- 5ee4afc: Order materialized-view creates by their `refresh.dependsOn` edges. Creates within the same kind were tie-broken purely by name, so a refreshable materialized view declared `DEPENDS ON other_mv` whose name sorted before its dependency could be created first and fail. The planner now creates a `DEPENDS ON` target before the view that depends on it; independent views keep their stable alphabetical order.
- 99136de: Add ObsessionDB onboarding to `chkit init` and `create-chkit`: a 3-way "how do you want to connect?" prompt covering an existing ClickHouse instance, an existing ObsessionDB account, and claiming a free ObsessionDB dev instance. Adds passwordless CLI signup (`chkit obsessiondb signup`, email + one-time code) with automatic personal-org creation, and `chkit obsessiondb service claim` to claim and provision a free instance, then write a ready-to-use connection.

  Non-interactive callers (agents/CI) now get a full runbook instead of dead-end prompts: when no TTY is detected, onboarding prints every connect path as runnable commands, and `signup` supports a two-step OTP flow — `--request-only` sends the code and prints the exact follow-up command, then `--email --code <CODE>` verifies without re-sending (which would otherwise invalidate the code). When an explicit connect path is requested but cannot complete (e.g. `--connect claim` with no email, or a bad code), `chkit init` and `create-chkit` now exit non-zero instead of falling through to "next steps" with a success status, so scripts can detect the failure.

- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- 75bf348: Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

  Notes:

  - The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
  - The remote backfill flag `--service-id` is renamed to `--service-slug`.

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

- f1066a6: Add `onBeforePluginCommand` hook allowing plugins to intercept other plugins' commands.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- fea565c: `chkit migrate` now flags a destructive table **recreate** (a `DROP TABLE` + `CREATE TABLE` caused by changing `engine`, `orderBy`, `primaryKey`, `partitionBy`, or `uniqueKey`) with a distinct `table_recreate_data_loss` warning instead of the generic `drop_table_data_loss`. The warning spells out that all rows are permanently deleted and the table is recreated empty, and recommends migrating via a temporary table to preserve data. Documented in the migrate and schema DSL reference pages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 2b51cfc: Scan the executable SQL of migrations for hand-written destructive statements, not just planner-emitted safety markers. A destructive statement (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DROP VIEW`/`DROP MATERIALIZED VIEW`, `DETACH`, or `DROP DATABASE`) with no `-- operation:` marker — whether the whole migration was hand-written or the statement was hand-appended to a generated one — was previously applied silently in non-interactive/CI runs, causing irreversible data loss. Such statements now require `--allow-destructive` (or `safety.allowDestructive`) like any other destructive operation. Planner-marked statements keep their existing risk classification (generated migrations emit one marker per statement), so a planner-approved non-danger operation such as a materialized-view recreate is not blocked. Commented-out statements are ignored (comments are stripped before scanning).
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 62652d8: `status` now reports `Applied` scoped to migrations present in your project's migrations directory, rather than a global count from the journal table. On a shared ObsessionDB journal this previously counted other tenants' rows and could show `Applied` greater than `Total`.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 8d5878a: Resume partially-applied synchronous (DDL) migrations instead of replaying from the first statement. Previously, if a multi-statement migration failed partway (e.g. statement 1 added a column, statement 2 failed), nothing was journaled and re-running replayed statement 1 — which then failed with "column already exists", leaving the migration permanently stuck with the database mutated. Sync statements now record per-statement journal state (`started` → `completed`/`failed`), mirroring the async path: completed statements are skipped on re-run so the migration resumes from where it failed. Resuming across a migration-file edit is refused (checksum guard).
- 6789850: `migrate --table` no longer silently skips hand-written migrations that have no `-- operation:` markers. Their target tables can't be determined, so they are now fail-safe **included** (rather than dropped, which left pending work unapplied while appearing successful) and reported — with a warning in human output and an `undeterminedMigrations` array in `--json` output.
- 0aa2c28: Load `.ts` config and schema files under plain Node, not only Bun. Previously every database command (`status`, `generate`, `migrate`, `check`, `drift`, `query`) failed on Node with `Unknown file extension ".ts"`, despite the docs advertising Node.js 20+. Config and schema modules now load through jiti on Node (and continue to use Bun's native importer under Bun). Also improves the cold-start error when a config can't resolve its dependencies: instead of a raw module-resolution error, chkit now reports which package is missing and tells you to run `bun install` (or `npm`/`pnpm install`).
- dfaa8fa: Document the pre-1.0 versioning, channel, and support policy in the chkit README, and lock-step all publishable packages into a single changesets fixed group so versions never skew across packages.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [f4e5a59]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [95e6dbb]
- Updated dependencies [ff1cd31]
- Updated dependencies [d9d5038]
- Updated dependencies [ca968d9]
- Updated dependencies [a94a2a1]
- Updated dependencies [17b8a27]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [8d5878a]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [5ee4afc]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [72c3fdd]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [0aa2c28]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.29
  - @chkit/clickhouse@0.1.0-beta.29
  - @chkit/codegen@0.1.0-beta.29

## 0.1.0-beta.28

### Patch Changes

- 2f1767f: Add debug logging via `CHKIT_DEBUG=1` environment variable. Logs config loading, command dispatch, plugin lifecycle hooks, ClickHouse queries with timing, journal operations, and per-command details to stderr.
- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- 500b7ba: Add the `create-chkit` package, a scaffolder that downloads a curated example from the chkit repository (default: `clickbench`) into a new project directory, rewrites `chkit` and `@chkit/*` dependency versions to `latest`, and runs install with the detected package manager. Restructure the Getting Started docs into two pages — "Start with an example" (using `create-chkit`) and "Add to an existing project" (using `chkit init`) — and update the docs URL printed by `chkit init` to point to the new page.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- 95e6dbb: Detect ClickHouse exceptions that arrive in the `x-clickhouse-exception-code` response header on an HTTP 200 response. When `send_progress_in_http_headers=1` is set (chkit's default for long-running migrations), ClickHouse commits to a 200 status before the query completes; if the query then errors, the exception is reported via response headers rather than as an HTTP error code. `@clickhouse/client` does not surface this as a thrown error, so previously `chkit migrate` could record a failed INSERT migration as applied while the data never landed.

  `@chkit/clickhouse` now inspects `result.response_headers` after every `command`/`query`/`queryJson`/`insert` call and throws a new `ClickHouseStreamedException` (with `code`, `exceptionTag`, and `query_id`) when a non-zero exception code is present. Migrations that fail this way now exit with a non-zero status and remain pending so the operator can fix the underlying issue and re-apply.

- ca968d9: Fix stale internal dependency pins in published packages. `chkit` shipped with `@chkit/plugin-obsessiondb` pinned one version behind because the publish step only resolved `workspace:` specifiers in `dependencies`/`devDependencies`, skipping `optionalDependencies` (where the plugin is declared) — so the CLI bundled an outdated plugin and every `chkit query` failed with `serviceSlug is required`.

  The publish resolver now covers every dependency field, `@chkit/codegen` uses `workspace:*` for `@chkit/core` instead of an exact pin, and two release guards (source-side `check:workspace-deps` and packed-tarball `check:packed-deps`) fail the build if any publishable package would ship a stale or unresolved internal dependency.

- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- 500b7ba: Add a `-- log: <message>` metadata key to migration files. When set, the message is printed to stdout immediately before the migration is applied, so operators see context for long-running or otherwise-noteworthy migrations (e.g. "Loading 100M rows, ~3-5 min"). Parsed from the leading `-- key: value` comment block; unknown keys are ignored so future additions stay backwards-compatible.
- 5a62874: Add `mode=async` annotation for long-running migration operations.

  Mark an operation as async by adding `mode=async` to its `-- operation:` header line, for example:

  ```sql
  -- operation: load_table_data key=table:default.hits risk=caution mode=async
  INSERT INTO default.hits SELECT * FROM s3(...);
  ```

  When `chkit migrate --apply` encounters an async operation it:

  1. Computes a deterministic `query_id` from `sha256(migration_filename + ':' + statement_index)`.
  2. Checks `system.processes` / `system.query_log` for any prior attempt with that id.
  3. Fires the INSERT via the existing `submit()` path without blocking on its HTTP response, and polls `queryStatus(query_id)` every 5 seconds — printing a one-line update (`written=N.NM rows (N.N GiB), elapsed Ns`) so the operator sees the load advance.
  4. On `QueryFinish` → records the journal entry and proceeds. On `ExceptionWhileProcessing` → throws with the server's exception. On any prior run's failure → resubmits (retry semantics).

  This unblocks two scenarios chkit could not previously handle:

  - **Long INSERTs through a proxy/LB with an HTTP request-duration ceiling**: the operator sees progress, and a connection drop mid-poll no longer cancels the work — the deterministic id lets a re-run attach to the in-flight query on the server.
  - **Transient client-side errors during a multi-minute load**: re-running chkit picks up where it left off rather than starting over.

  Existing migrations without `mode=async` continue to use the synchronous path; the annotation is opt-in and forward-compatible (an unknown mode value falls back to sync).

- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- 75bf348: Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

  Notes:

  - The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
  - The remote backfill flag `--service-id` is renamed to `--service-slug`.

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

- f1066a6: Add `onBeforePluginCommand` hook allowing plugins to intercept other plugins' commands.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [95e6dbb]
- Updated dependencies [ca968d9]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.28
  - @chkit/clickhouse@0.1.0-beta.28
  - @chkit/codegen@0.1.0-beta.28

## 0.1.0-beta.27

### Patch Changes

- 2f1767f: Add debug logging via `CHKIT_DEBUG=1` environment variable. Logs config loading, command dispatch, plugin lifecycle hooks, ClickHouse queries with timing, journal operations, and per-command details to stderr.
- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- 500b7ba: Add the `create-chkit` package, a scaffolder that downloads a curated example from the chkit repository (default: `clickbench`) into a new project directory, rewrites `chkit` and `@chkit/*` dependency versions to `latest`, and runs install with the detected package manager. Restructure the Getting Started docs into two pages — "Start with an example" (using `create-chkit`) and "Add to an existing project" (using `chkit init`) — and update the docs URL printed by `chkit init` to point to the new page.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- 95e6dbb: Detect ClickHouse exceptions that arrive in the `x-clickhouse-exception-code` response header on an HTTP 200 response. When `send_progress_in_http_headers=1` is set (chkit's default for long-running migrations), ClickHouse commits to a 200 status before the query completes; if the query then errors, the exception is reported via response headers rather than as an HTTP error code. `@clickhouse/client` does not surface this as a thrown error, so previously `chkit migrate` could record a failed INSERT migration as applied while the data never landed.

  `@chkit/clickhouse` now inspects `result.response_headers` after every `command`/`query`/`queryJson`/`insert` call and throws a new `ClickHouseStreamedException` (with `code`, `exceptionTag`, and `query_id`) when a non-zero exception code is present. Migrations that fail this way now exit with a non-zero status and remain pending so the operator can fix the underlying issue and re-apply.

- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- 500b7ba: Add a `-- log: <message>` metadata key to migration files. When set, the message is printed to stdout immediately before the migration is applied, so operators see context for long-running or otherwise-noteworthy migrations (e.g. "Loading 100M rows, ~3-5 min"). Parsed from the leading `-- key: value` comment block; unknown keys are ignored so future additions stay backwards-compatible.
- 5a62874: Add `mode=async` annotation for long-running migration operations.

  Mark an operation as async by adding `mode=async` to its `-- operation:` header line, for example:

  ```sql
  -- operation: load_table_data key=table:default.hits risk=caution mode=async
  INSERT INTO default.hits SELECT * FROM s3(...);
  ```

  When `chkit migrate --apply` encounters an async operation it:

  1. Computes a deterministic `query_id` from `sha256(migration_filename + ':' + statement_index)`.
  2. Checks `system.processes` / `system.query_log` for any prior attempt with that id.
  3. Fires the INSERT via the existing `submit()` path without blocking on its HTTP response, and polls `queryStatus(query_id)` every 5 seconds — printing a one-line update (`written=N.NM rows (N.N GiB), elapsed Ns`) so the operator sees the load advance.
  4. On `QueryFinish` → records the journal entry and proceeds. On `ExceptionWhileProcessing` → throws with the server's exception. On any prior run's failure → resubmits (retry semantics).

  This unblocks two scenarios chkit could not previously handle:

  - **Long INSERTs through a proxy/LB with an HTTP request-duration ceiling**: the operator sees progress, and a connection drop mid-poll no longer cancels the work — the deterministic id lets a re-run attach to the in-flight query on the server.
  - **Transient client-side errors during a multi-minute load**: re-running chkit picks up where it left off rather than starting over.

  Existing migrations without `mode=async` continue to use the synchronous path; the annotation is opt-in and forward-compatible (an unknown mode value falls back to sync).

- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
- 75bf348: Fix broken ObsessionDB integration after the platform moved service-scoped RPC endpoints from `serviceId` to `serviceSlug`. The plugin now sources and stores the service slug instead of the id and sends `serviceSlug` to `workbench.query.execute`, `jobs.list`/`submit`, and `services.get`. This repairs `migrate`, `generate`, `status`, `drift`, `check`, `query`, and remote backfill against ObsessionDB targets. The bundled oRPC contract copies were also refreshed to match the current platform schemas (services now expose `slug`, query results are array-of-arrays, job details carry per-task runs).

  Notes:

  - The selected-service file (`obsessiondb.json`) now stores `service_slug` instead of `service_id`. Existing selections will need to be re-run with `chkit obsessiondb service select` (and any aliases re-set).
  - The remote backfill flag `--service-id` is renamed to `--service-slug`.

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

- f1066a6: Add `onBeforePluginCommand` hook allowing plugins to intercept other plugins' commands.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [95e6dbb]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.27
  - @chkit/clickhouse@0.1.0-beta.27
  - @chkit/codegen@0.1.0-beta.27

## 0.1.0-beta.26

### Patch Changes

- 2f1767f: Add debug logging via `CHKIT_DEBUG=1` environment variable. Logs config loading, command dispatch, plugin lifecycle hooks, ClickHouse queries with timing, journal operations, and per-command details to stderr.
- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- 500b7ba: Add the `create-chkit` package, a scaffolder that downloads a curated example from the chkit repository (default: `clickbench`) into a new project directory, rewrites `chkit` and `@chkit/*` dependency versions to `latest`, and runs install with the detected package manager. Restructure the Getting Started docs into two pages — "Start with an example" (using `create-chkit`) and "Add to an existing project" (using `chkit init`) — and update the docs URL printed by `chkit init` to point to the new page.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- 500b7ba: Add a `-- log: <message>` metadata key to migration files. When set, the message is printed to stdout immediately before the migration is applied, so operators see context for long-running or otherwise-noteworthy migrations (e.g. "Loading 100M rows, ~3-5 min"). Parsed from the leading `-- key: value` comment block; unknown keys are ignored so future additions stay backwards-compatible.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
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

- f1066a6: Add `onBeforePluginCommand` hook allowing plugins to intercept other plugins' commands.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.26
  - @chkit/clickhouse@0.1.0-beta.26
  - @chkit/codegen@0.1.0-beta.26

## 0.1.0-beta.25

### Patch Changes

- 2f1767f: Add debug logging via `CHKIT_DEBUG=1` environment variable. Logs config loading, command dispatch, plugin lifecycle hooks, ClickHouse queries with timing, journal operations, and per-command details to stderr.
- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
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

- f1066a6: Add `onBeforePluginCommand` hook allowing plugins to intercept other plugins' commands.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.25
  - @chkit/clickhouse@0.1.0-beta.25
  - @chkit/codegen@0.1.0-beta.25

## 0.1.0-beta.24

### Patch Changes

- 2f1767f: Add debug logging via `CHKIT_DEBUG=1` environment variable. Logs config loading, command dispatch, plugin lifecycle hooks, ClickHouse queries with timing, journal operations, and per-command details to stderr.
- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 0011d85: Add ObsessionDB service aliases for `--service`. Users can manage aliases with `chkit obsessiondb service alias set|list|remove`, and `--service` now resolves exact service names before falling back to saved aliases.
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

- f1066a6: Add `onBeforePluginCommand` hook allowing plugins to intercept other plugins' commands.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `service select`, or `--service` as appropriate.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.24
  - @chkit/clickhouse@0.1.0-beta.24
  - @chkit/codegen@0.1.0-beta.24

## 0.1.0-beta.23

### Patch Changes

- 2f1767f: Add debug logging via `CHKIT_DEBUG=1` environment variable. Logs config loading, command dispatch, plugin lifecycle hooks, ClickHouse queries with timing, journal operations, and per-command details to stderr.
- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
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

- f1066a6: Add `onBeforePluginCommand` hook allowing plugins to intercept other plugins' commands.
- 5856d48: Add user-profile config fallback so `chkit query` works from any directory without a local `clickhouse.config.ts`. When no project config is found in the current directory, chkit now looks for `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). If ObsessionDB credentials exist (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config and loads the ObsessionDB plugin through an optional runtime import. ObsessionDB bootstrap commands such as `chkit obsessiondb login` can also run before credentials exist. Project-only commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) still require a project config. The ObsessionDB plugin now persists the selected service to `~/.config/chkit/obsessiondb.json` when running in profile mode, and query errors now point users to `login`, `select-service`, or `--service` as appropriate.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.23
  - @chkit/clickhouse@0.1.0-beta.23
  - @chkit/codegen@0.1.0-beta.23

## 0.1.0-beta.22

### Patch Changes

- 2f1767f: Add debug logging via `CHKIT_DEBUG=1` environment variable. Logs config loading, command dispatch, plugin lifecycle hooks, ClickHouse queries with timing, journal operations, and per-command details to stderr.
- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- f4ff75d: Add `chkit query "<sql>"` command that runs an ad-hoc SQL query against the configured target (default ClickHouse, or the active plugin executor). When the ObsessionDB plugin is loaded, all ClickHouse-bound commands (`generate`, `migrate`, `status`, `drift`, `check`, `query`) accept `--service <name>` to override the selected service by name for that single invocation.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
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

- f1066a6: Add `onBeforePluginCommand` hook allowing plugins to intercept other plugins' commands.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [0f5f4c6]
- Updated dependencies [aecb106]
- Updated dependencies [c396fb5]
- Updated dependencies [ffdcdb9]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.22
  - @chkit/clickhouse@0.1.0-beta.22
  - @chkit/codegen@0.1.0-beta.22

## 0.1.0-beta.21

### Patch Changes

- 2f1767f: Add debug logging via `CHKIT_DEBUG=1` environment variable. Logs config loading, command dispatch, plugin lifecycle hooks, ClickHouse queries with timing, journal operations, and per-command details to stderr.
- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
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

- f1066a6: Add `onBeforePluginCommand` hook allowing plugins to intercept other plugins' commands.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [8112b46]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [50a34db]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.21
  - @chkit/clickhouse@0.1.0-beta.21
  - @chkit/codegen@0.1.0-beta.21

## 0.1.0-beta.20

### Patch Changes

- 2f1767f: Add debug logging via `CHKIT_DEBUG=1` environment variable. Logs config loading, command dispatch, plugin lifecycle hooks, ClickHouse queries with timing, journal operations, and per-command details to stderr.
- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- c8af201: Add query routing through ObsessionDB: core commands (migrate, status, drift, check) use a plugin-provided ClickHouse executor when authenticated with a selected service. Adds `getContext` plugin hook, per-project service binding during login, `select-service` command, and remote executor that proxies queries through the ObsessionDB API.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- f1066a6: Add `onBeforePluginCommand` hook allowing plugins to intercept other plugins' commands.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [cb09aaa]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [8112b46]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [45ff0fe]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.20
  - @chkit/clickhouse@0.1.0-beta.20
  - @chkit/codegen@0.1.0-beta.20

## 0.1.0-beta.19

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.19
  - @chkit/clickhouse@0.1.0-beta.19
  - @chkit/codegen@0.1.0-beta.19

## 0.1.0-beta.18

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [c396fb5]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.18
  - @chkit/clickhouse@0.1.0-beta.18
  - @chkit/codegen@0.1.0-beta.18

## 0.1.0-beta.17

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [6348ef2]
- Updated dependencies [a94a2a1]
- Updated dependencies [638f75f]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [949a20c]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.17
  - @chkit/clickhouse@0.1.0-beta.17
  - @chkit/codegen@0.1.0-beta.17

## 0.1.0-beta.16

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/clickhouse@0.1.0-beta.16
  - @chkit/codegen@0.1.0-beta.16
  - @chkit/core@0.1.0-beta.16

## 0.1.0-beta.15

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.15
  - @chkit/codegen@0.1.0-beta.15
  - @chkit/core@0.1.0-beta.15

## 0.1.0-beta.14

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.14
  - @chkit/codegen@0.1.0-beta.14
  - @chkit/core@0.1.0-beta.14

## 0.1.0-beta.13

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.13
  - @chkit/codegen@0.1.0-beta.13
  - @chkit/core@0.1.0-beta.13

## 0.1.0-beta.12

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- c25503c: Make skill-hint plugin agent-aware to support all agents (Cursor, Windsurf, Roo, etc). Previously, the plugin only showed install prompts for Claude Code even when used in other agents. Now it detects the agent environment and displays agent-specific messages.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.12
  - @chkit/codegen@0.1.0-beta.12
  - @chkit/core@0.1.0-beta.12

## 0.1.0-beta.11

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- 4afb7cf: Fix agent skill installation path when running from a monorepo subfolder. The skill hint now walks up to the repository root instead of installing into the current working directory.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.11
  - @chkit/codegen@0.1.0-beta.11
  - @chkit/core@0.1.0-beta.11

## 0.1.0-beta.10

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- e858da9: Add onInit/onComplete plugin lifecycle hooks and hint users to install the chkit Claude agent skill. The skill hint prompts once per month in interactive mode and can be dismissed.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.10
  - @chkit/codegen@0.1.0-beta.10
  - @chkit/core@0.1.0-beta.10

## 0.1.0-beta.9

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.9
  - @chkit/codegen@0.1.0-beta.9
  - @chkit/core@0.1.0-beta.9

## 0.1.0-beta.8

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- a94a2a1: Fix migration ordering so tables are created before views and materialized views that depend on them.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.8
  - @chkit/codegen@0.1.0-beta.8
  - @chkit/core@0.1.0-beta.8

## 0.1.0-beta.7

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [f719c50]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.7
  - @chkit/codegen@0.1.0-beta.7
  - @chkit/core@0.1.0-beta.7

## 0.1.0-beta.6

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [f719c50]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.6
  - @chkit/codegen@0.1.0-beta.6
  - @chkit/core@0.1.0-beta.6

## 0.1.0-beta.5

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [f719c50]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.5
  - @chkit/codegen@0.1.0-beta.5
  - @chkit/core@0.1.0-beta.5

## 0.1.0-beta.4

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [f719c50]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.4
  - @chkit/codegen@0.1.0-beta.4
  - @chkit/core@0.1.0-beta.4

## 0.1.0-beta.3

### Patch Changes

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- Updated dependencies [a3a09cf]
  - @chkit/clickhouse@0.1.0-beta.3
  - @chkit/codegen@0.1.0-beta.3
  - @chkit/core@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- Updated dependencies [f719c50]
  - @chkit/clickhouse@0.1.0-beta.2
  - @chkit/codegen@0.1.0-beta.2
  - @chkit/core@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- Rename internals and CLI binary from chkit to chkit.
- Updated dependencies
  - @chkit/clickhouse@0.1.0-beta.1
  - @chkit/codegen@0.1.0-beta.1
  - @chkit/core@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- Initial beta release of the chkit ClickHouse schema and migration toolkit. Includes the CLI, core schema planner, codegen, ClickHouse client integration, and plugins for pull, typegen, and backfill.

### Patch Changes

- Updated dependencies
  - @chkit/clickhouse@0.1.0-beta.0
  - @chkit/codegen@0.1.0-beta.0
  - @chkit/core@0.1.0-beta.0
