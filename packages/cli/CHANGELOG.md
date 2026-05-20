# chkit

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
