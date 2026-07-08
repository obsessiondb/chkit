# @chkit/plugin-backfill

## 0.1.2-beta.4

### Patch Changes

- f85f568: Fix `mv_replay` backfill of a from-scratch empty aggregate target. Chunk planning now sizes chunks against the materialized view's source table (the one it reads `FROM`) instead of the target, so bootstrapping an empty rollup no longer fails with "No partitions found for &lt;target&gt;". The empty-check still guards the source, and multi-view fan-in from different sources keeps its existing behaviour.
- 3f9a246: Fix `backfill` mv_replay so it rebuilds **every** materialized view feeding the target table, not just the first. ClickHouse allows several MVs to share one destination table; previously only the first-declared MV was replayed and the rest were silently dropped, leaving the backfill incomplete. Each chunk now runs one `INSERT INTO target … SELECT … UNION ALL SELECT …` covering all matching MVs, so a single query id and idempotency token still cover the chunk. Single-MV plans are unchanged.
- 9ad23f9: Refactor the backfill chunk-SQL rewriter (`chunking/sql.ts`): fold the duplicated quote/paren-aware scan loops into one shared `scanSqlTokens` primitive (with `findTopLevelKeywords`/`splitTopLevel` on top) and split the oversized `rewriteSelectColumns` into focused helpers. Behavior is unchanged — the same customer SQL rewriting is now covered by direct unit tests for quoted-string, escaped-quote, nested-subquery, and missing-FROM edge cases.
- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.4
  - @chkit/clickhouse@0.1.2-beta.4

## 0.1.2-beta.3

### Patch Changes

- f85f568: Fix `mv_replay` backfill of a from-scratch empty aggregate target. Chunk planning now sizes chunks against the materialized view's source table (the one it reads `FROM`) instead of the target, so bootstrapping an empty rollup no longer fails with "No partitions found for &lt;target&gt;". The empty-check still guards the source, and multi-view fan-in from different sources keeps its existing behaviour.
- 3f9a246: Fix `backfill` mv_replay so it rebuilds **every** materialized view feeding the target table, not just the first. ClickHouse allows several MVs to share one destination table; previously only the first-declared MV was replayed and the rest were silently dropped, leaving the backfill incomplete. Each chunk now runs one `INSERT INTO target … SELECT … UNION ALL SELECT …` covering all matching MVs, so a single query id and idempotency token still cover the chunk. Single-MV plans are unchanged.
- 9ad23f9: Refactor the backfill chunk-SQL rewriter (`chunking/sql.ts`): fold the duplicated quote/paren-aware scan loops into one shared `scanSqlTokens` primitive (with `findTopLevelKeywords`/`splitTopLevel` on top) and split the oversized `rewriteSelectColumns` into focused helpers. Behavior is unchanged — the same customer SQL rewriting is now covered by direct unit tests for quoted-string, escaped-quote, nested-subquery, and missing-FROM edge cases.
- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.3
  - @chkit/clickhouse@0.1.2-beta.3

## 0.1.2-beta.2

### Patch Changes

- 3f9a246: Fix `backfill` mv_replay so it rebuilds **every** materialized view feeding the target table, not just the first. ClickHouse allows several MVs to share one destination table; previously only the first-declared MV was replayed and the rest were silently dropped, leaving the backfill incomplete. Each chunk now runs one `INSERT INTO target … SELECT … UNION ALL SELECT …` covering all matching MVs, so a single query id and idempotency token still cover the chunk. Single-MV plans are unchanged.
- 9ad23f9: Refactor the backfill chunk-SQL rewriter (`chunking/sql.ts`): fold the duplicated quote/paren-aware scan loops into one shared `scanSqlTokens` primitive (with `findTopLevelKeywords`/`splitTopLevel` on top) and split the oversized `rewriteSelectColumns` into focused helpers. Behavior is unchanged — the same customer SQL rewriting is now covered by direct unit tests for quoted-string, escaped-quote, nested-subquery, and missing-FROM edge cases.
- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.2
  - @chkit/clickhouse@0.1.2-beta.2

## 0.1.2-beta.1

### Patch Changes

- 9ad23f9: Refactor the backfill chunk-SQL rewriter (`chunking/sql.ts`): fold the duplicated quote/paren-aware scan loops into one shared `scanSqlTokens` primitive (with `findTopLevelKeywords`/`splitTopLevel` on top) and split the oversized `rewriteSelectColumns` into focused helpers. Behavior is unchanged — the same customer SQL rewriting is now covered by direct unit tests for quoted-string, escaped-quote, nested-subquery, and missing-FROM edge cases.
- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.1
  - @chkit/clickhouse@0.1.2-beta.1

## 0.1.2-beta.0

### Patch Changes

- 9ad23f9: Refactor the backfill chunk-SQL rewriter (`chunking/sql.ts`): fold the duplicated quote/paren-aware scan loops into one shared `scanSqlTokens` primitive (with `findTopLevelKeywords`/`splitTopLevel` on top) and split the oversized `rewriteSelectColumns` into focused helpers. Behavior is unchanged — the same customer SQL rewriting is now covered by direct unit tests for quoted-string, escaped-quote, nested-subquery, and missing-FROM edge cases.
- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.0
  - @chkit/clickhouse@0.1.2-beta.0

## 0.1.1

### Patch Changes

- c1d8d0d: Add `chkit backfill submit` to run a backfill as a managed ObsessionDB job. It builds the plan with the same chunking algorithm as the local `run`, submits the chunks to the ObsessionDB job backend, and prints a console link to track progress instead of polling locally — the heavier, MV-replay-aware path lives in the ObsessionDB plugin. The plugin's remote executor now forwards ClickHouse query settings (e.g. `enable_parallel_replicas`) so remote plan sizing matches the local planner.
- Updated dependencies [6b87e6d]
  - @chkit/core@0.1.1
  - @chkit/clickhouse@0.1.1

## 0.1.0

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
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

## 0.1.0-beta.29

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
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

## 0.1.0-beta.28

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
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
  - @chkit/core@0.1.0-beta.28
  - @chkit/clickhouse@0.1.0-beta.28

## 0.1.0-beta.27

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
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

## 0.1.0-beta.26

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
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

## 0.1.0-beta.25

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
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

## 0.1.0-beta.24

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
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

## 0.1.0-beta.23

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
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

## 0.1.0-beta.22

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
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

## 0.1.0-beta.21

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 50a34db: Add structured logging to backfill chunk planning via `@logtape/logtape`. The smart chunking planner now logs introspection, partition planning, and per-strategy split decisions, and emits warnings when ClickHouse queries exceed 5s. Enable with `CHKIT_DEBUG=1`.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
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

## 0.1.0-beta.20

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
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

## 0.1.0-beta.19

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
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

## 0.1.0-beta.18

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
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

## 0.1.0-beta.17

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
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

## 0.1.0-beta.16

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 1250daf: Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
- 92458f4: Bind backfill plans to ClickHouse environment. Plans now include an environment fingerprint (URL origin + database) when created with a ClickHouse config, preventing accidental cross-environment execution. Running or resuming a plan against a mismatched environment is blocked by default; use `--force-environment` to override. Plans created offline (without ClickHouse config) work against any environment for backward compatibility.
- ae83b75: Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- ebca417: Fix backfill runtime issues: add exponential backoff between retries (configurable via `defaults.retryDelayMs`, default 1000ms), continue processing remaining chunks after one fails permanently (instead of stopping), and make `resume` automatically retry failed chunks without requiring `--replay-failed`.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- 2495742: Add backfill UX improvements: Track rows-written per chunk and warn when 0 rows complete, add `--force` flag to regenerate plans, handle graceful shutdown with signal handling, return exit code 0 for completed re-runs with friendly message, and always show lastError in non-JSON output.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 35365d2: Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- eff3a22: Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT \* and adds computed columns.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
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
  - @chkit/core@0.1.0-beta.16

## 0.1.0-beta.15

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a989bb7: Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.15

## 0.1.0-beta.14

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.14

## 0.1.0-beta.13

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.13

## 0.1.0-beta.12

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- fe34638: Make backfill time column configurable with smart auto-detection. Replace hardcoded `event_time` column with support for `--time-column` CLI flag, `defaults.timeColumn` config option, and interactive detection that scans schema definitions for DateTime columns in ORDER BY or by common naming conventions.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.12

## 0.1.0-beta.11

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.11

## 0.1.0-beta.10

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.10

## 0.1.0-beta.9

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.9

## 0.1.0-beta.8

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
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
  - @chkit/core@0.1.0-beta.7

## 0.1.0-beta.6

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [f719c50]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.6

## 0.1.0-beta.5

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [f719c50]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.5

## 0.1.0-beta.4

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [f719c50]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/core@0.1.0-beta.4

## 0.1.0-beta.3

### Patch Changes

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- Updated dependencies [a3a09cf]
  - @chkit/core@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- Updated dependencies [f719c50]
  - @chkit/core@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- Rename internals and CLI binary from chkit to chkit.
- Updated dependencies
  - @chkit/core@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- Initial beta release of the chkit ClickHouse schema and migration toolkit. Includes the CLI, core schema planner, codegen, ClickHouse client integration, and plugins for pull, typegen, and backfill.

### Patch Changes

- Updated dependencies
  - @chkit/core@0.1.0-beta.0
