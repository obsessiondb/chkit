# @chkit/plugin-backfill

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
