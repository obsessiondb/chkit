# @chkit/clickhouse

## 0.1.2-beta.5

### Patch Changes

- 3f1db03: Support index-only projections (`PROJECTION p INDEX (a, b) TYPE basic`) end to end. `ProjectionDefinition` is now a union of the existing `{ name, query }` SELECT form and a new `{ name, index, type }` index-only form, which renders without the wrapping parens that made the SELECT form invalid for it. `chkit pull` previously parsed only the SELECT form and dropped index-only projections on the floor, so a pulled schema silently recreated the table without them; they now round-trip through pull, generate, migrate, and drift.

  Index expressions are normalized to the exact form ClickHouse stores — a single expression bare (`INDEX a`), several as a tuple (`INDEX (a, b)`), redundant parens peeled at every level, and a space after each argument separator — so `'(a)'` and `'a'`, or `'concat(x,y)'` and `'concat(x, y)'`, describe the same table and no longer read as drift.

  Two new validation errors guard the new form: `projection_ambiguous_kind` when an entry sets both `query` and `index` (which would otherwise silently discard the SELECT body), and `projection_empty_index` when the index expression is empty (which would otherwise emit invalid DDL).

- Updated dependencies [3f1db03]
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.5

## 0.1.2-beta.4

### Patch Changes

- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.4

## 0.1.2-beta.2

### Patch Changes

- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.2

## 0.1.2-beta.1

### Patch Changes

- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.1

## 0.1.2-beta.0

### Patch Changes

- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.0

## 0.1.1

### Patch Changes

- Updated dependencies [6b87e6d]
  - @chkit/core@0.1.1

## 0.1.0

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- f4e5a59: Replace the leaked ClickHouse server blurb on an authentication failure with a single clear line. A wrong `CLICKHOUSE_PASSWORD` previously dumped ~8 lines of ClickHouse Cloud password-reset instructions and `/etc/clickhouse-server/users.d/` filesystem paths that read as an internal error leak. chkit now detects auth failures (ClickHouse error codes 194/516, `REQUIRED_PASSWORD`/`AUTHENTICATION_FAILED`, or an "Authentication failed" message) and reports: `Authentication failed for user "<user>" at <url>. Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD.`
- 0f5f4c6: Connection-refused errors now hint at the missing `CLICKHOUSE_URL` env var when chkit fell back to the default `http://localhost:8123` endpoint. Previously, first-time users who forgot to set the env var saw a bare "connection refused" message with no clue that the env var was the fix.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- 95e6dbb: Detect ClickHouse exceptions that arrive in the `x-clickhouse-exception-code` response header on an HTTP 200 response. When `send_progress_in_http_headers=1` is set (chkit's default for long-running migrations), ClickHouse commits to a 200 status before the query completes; if the query then errors, the exception is reported via response headers rather than as an HTTP error code. `@clickhouse/client` does not surface this as a thrown error, so previously `chkit migrate` could record a failed INSERT migration as applied while the data never landed.

  `@chkit/clickhouse` now inspects `result.response_headers` after every `command`/`query`/`queryJson`/`insert` call and throws a new `ClickHouseStreamedException` (with `code`, `exceptionTag`, and `query_id`) when a non-zero exception code is present. Migrations that fail this way now exit with a non-zero status and remain pending so the operator can fix the underlying issue and re-apply.

- d9d5038: Polish error messages and a few noisy outputs:

  - A table defined with `orderBy` but no `primaryKey` no longer crashes with a raw `TypeError`; the primary key defaults to the order-by columns, matching ClickHouse.
  - Built-in command errors (e.g. a rejected migration) surface their own clean message instead of being wrapped in `Plugin "core" failed in ...`.
  - `chkit query` syntax errors no longer leak the injected `FORMAT JSON` clause the user never typed, and the "Expected one of" token dump is capped.
  - Connection errors whose reason is only in the message (no `.code`) — e.g. a typo'd host — are now recognized and cleaned instead of leaking the raw client string.
  - The post-apply message names the resolved journal table (respecting `CHKIT_JOURNAL_TABLE`) instead of a hardcoded `_chkit_migrations`.
  - The ObsessionDB "authenticated but no service selected" reminder is suppressed when a direct `clickhouse` target is configured (it was layered in from a global login, not chosen for the project).

- 17b8a27: Fix the `@chkit/clickhouse/e2e-testkit` subpath export. Both conditions pointed at `./src/e2e-testkit.ts`, which `files: ["dist"]` excludes from the published tarball, so importing the subpath from the published package hit a hard module-not-found. Build it to `dist` and point the export there (keeping a `source` condition for in-repo type resolution).
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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

- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 72c3fdd: Silence the built-in @clickhouse/client logger so a wrong password (or any connection error) no
  longer leaks the raw ClickHouse server remediation blurb to stderr. chkit emits its own clean
  one-line message and now sets the client log level to OFF explicitly, independent of the resolved
  @clickhouse/client version (the upstream default changed from OFF to WARN in 1.18). Also raises
  the @clickhouse/client dependency floor to ^1.18.0 so the shipped behavior matches what consumers
  resolve.
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
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [ff1cd31]
- Updated dependencies [d9d5038]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [8d5878a]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [5ee4afc]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [0aa2c28]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0

## 0.1.0-beta.29

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- f4e5a59: Replace the leaked ClickHouse server blurb on an authentication failure with a single clear line. A wrong `CLICKHOUSE_PASSWORD` previously dumped ~8 lines of ClickHouse Cloud password-reset instructions and `/etc/clickhouse-server/users.d/` filesystem paths that read as an internal error leak. chkit now detects auth failures (ClickHouse error codes 194/516, `REQUIRED_PASSWORD`/`AUTHENTICATION_FAILED`, or an "Authentication failed" message) and reports: `Authentication failed for user "<user>" at <url>. Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD.`
- 0f5f4c6: Connection-refused errors now hint at the missing `CLICKHOUSE_URL` env var when chkit fell back to the default `http://localhost:8123` endpoint. Previously, first-time users who forgot to set the env var saw a bare "connection refused" message with no clue that the env var was the fix.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- 95e6dbb: Detect ClickHouse exceptions that arrive in the `x-clickhouse-exception-code` response header on an HTTP 200 response. When `send_progress_in_http_headers=1` is set (chkit's default for long-running migrations), ClickHouse commits to a 200 status before the query completes; if the query then errors, the exception is reported via response headers rather than as an HTTP error code. `@clickhouse/client` does not surface this as a thrown error, so previously `chkit migrate` could record a failed INSERT migration as applied while the data never landed.

  `@chkit/clickhouse` now inspects `result.response_headers` after every `command`/`query`/`queryJson`/`insert` call and throws a new `ClickHouseStreamedException` (with `code`, `exceptionTag`, and `query_id`) when a non-zero exception code is present. Migrations that fail this way now exit with a non-zero status and remain pending so the operator can fix the underlying issue and re-apply.

- d9d5038: Polish error messages and a few noisy outputs:

  - A table defined with `orderBy` but no `primaryKey` no longer crashes with a raw `TypeError`; the primary key defaults to the order-by columns, matching ClickHouse.
  - Built-in command errors (e.g. a rejected migration) surface their own clean message instead of being wrapped in `Plugin "core" failed in ...`.
  - `chkit query` syntax errors no longer leak the injected `FORMAT JSON` clause the user never typed, and the "Expected one of" token dump is capped.
  - Connection errors whose reason is only in the message (no `.code`) — e.g. a typo'd host — are now recognized and cleaned instead of leaking the raw client string.
  - The post-apply message names the resolved journal table (respecting `CHKIT_JOURNAL_TABLE`) instead of a hardcoded `_chkit_migrations`.
  - The ObsessionDB "authenticated but no service selected" reminder is suppressed when a direct `clickhouse` target is configured (it was layered in from a global login, not chosen for the project).

- 17b8a27: Fix the `@chkit/clickhouse/e2e-testkit` subpath export. Both conditions pointed at `./src/e2e-testkit.ts`, which `files: ["dist"]` excludes from the published tarball, so importing the subpath from the published package hit a hard module-not-found. Build it to `dist` and point the export there (keeping a `source` condition for in-repo type resolution).
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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

- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 72c3fdd: Silence the built-in @clickhouse/client logger so a wrong password (or any connection error) no
  longer leaks the raw ClickHouse server remediation blurb to stderr. chkit emits its own clean
  one-line message and now sets the client log level to OFF explicitly, independent of the resolved
  @clickhouse/client version (the upstream default changed from OFF to WARN in 1.18). Also raises
  the @clickhouse/client dependency floor to ^1.18.0 so the shipped behavior matches what consumers
  resolve.
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
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [ff1cd31]
- Updated dependencies [d9d5038]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [8d5878a]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [5ee4afc]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [0aa2c28]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.29

## 0.1.0-beta.28

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 0f5f4c6: Connection-refused errors now hint at the missing `CLICKHOUSE_URL` env var when chkit fell back to the default `http://localhost:8123` endpoint. Previously, first-time users who forgot to set the env var saw a bare "connection refused" message with no clue that the env var was the fix.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- 95e6dbb: Detect ClickHouse exceptions that arrive in the `x-clickhouse-exception-code` response header on an HTTP 200 response. When `send_progress_in_http_headers=1` is set (chkit's default for long-running migrations), ClickHouse commits to a 200 status before the query completes; if the query then errors, the exception is reported via response headers rather than as an HTTP error code. `@clickhouse/client` does not surface this as a thrown error, so previously `chkit migrate` could record a failed INSERT migration as applied while the data never landed.

  `@chkit/clickhouse` now inspects `result.response_headers` after every `command`/`query`/`queryJson`/`insert` call and throws a new `ClickHouseStreamedException` (with `code`, `exceptionTag`, and `query_id`) when a non-zero exception code is present. Migrations that fail this way now exit with a non-zero status and remain pending so the operator can fix the underlying issue and re-apply.

- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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

- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.28

## 0.1.0-beta.27

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 0f5f4c6: Connection-refused errors now hint at the missing `CLICKHOUSE_URL` env var when chkit fell back to the default `http://localhost:8123` endpoint. Previously, first-time users who forgot to set the env var saw a bare "connection refused" message with no clue that the env var was the fix.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- 95e6dbb: Detect ClickHouse exceptions that arrive in the `x-clickhouse-exception-code` response header on an HTTP 200 response. When `send_progress_in_http_headers=1` is set (chkit's default for long-running migrations), ClickHouse commits to a 200 status before the query completes; if the query then errors, the exception is reported via response headers rather than as an HTTP error code. `@clickhouse/client` does not surface this as a thrown error, so previously `chkit migrate` could record a failed INSERT migration as applied while the data never landed.

  `@chkit/clickhouse` now inspects `result.response_headers` after every `command`/`query`/`queryJson`/`insert` call and throws a new `ClickHouseStreamedException` (with `code`, `exceptionTag`, and `query_id`) when a non-zero exception code is present. Migrations that fail this way now exit with a non-zero status and remain pending so the operator can fix the underlying issue and re-apply.

- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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

- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.27

## 0.1.0-beta.26

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 0f5f4c6: Connection-refused errors now hint at the missing `CLICKHOUSE_URL` env var when chkit fell back to the default `http://localhost:8123` endpoint. Previously, first-time users who forgot to set the env var saw a bare "connection refused" message with no clue that the env var was the fix.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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

- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.26

## 0.1.0-beta.25

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 0f5f4c6: Connection-refused errors now hint at the missing `CLICKHOUSE_URL` env var when chkit fell back to the default `http://localhost:8123` endpoint. Previously, first-time users who forgot to set the env var saw a bare "connection refused" message with no clue that the env var was the fix.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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

- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.25

## 0.1.0-beta.24

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 0f5f4c6: Connection-refused errors now hint at the missing `CLICKHOUSE_URL` env var when chkit fell back to the default `http://localhost:8123` endpoint. Previously, first-time users who forgot to set the env var saw a bare "connection refused" message with no clue that the env var was the fix.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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

- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.24

## 0.1.0-beta.23

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 0f5f4c6: Connection-refused errors now hint at the missing `CLICKHOUSE_URL` env var when chkit fell back to the default `http://localhost:8123` endpoint. Previously, first-time users who forgot to set the env var saw a bare "connection refused" message with no clue that the env var was the fix.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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

- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.23

## 0.1.0-beta.22

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 0f5f4c6: Connection-refused errors now hint at the missing `CLICKHOUSE_URL` env var when chkit fell back to the default `http://localhost:8123` endpoint. Previously, first-time users who forgot to set the env var saw a bare "connection refused" message with no clue that the env var was the fix.
- aecb106: Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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

- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.22

## 0.1.0-beta.21

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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

- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
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

- 50a34db: Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.21

## 0.1.0-beta.20

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- cb09aaa: Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- 8112b46: Report intermediate query metrics (read_rows, written_rows, elapsed, etc.) from system.processes during backfill polling. Previously queryStatus returned only `{ status: 'running' }` with no metrics, and onProgress only fired on state transitions. Now every poll with metric changes triggers onProgress, giving visibility into long-running chunks.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- 45ff0fe: Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.20

## 0.1.0-beta.19

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [1a5caa3]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.19

## 0.1.0-beta.18

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [c396fb5]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.18

## 0.1.0-beta.17

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 6348ef2: Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
- 638f75f: Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 949a20c: Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [c63c74f]
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.17

## 0.1.0-beta.16

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- Updated dependencies [ba60638]
- Updated dependencies [a94a2a1]
- Updated dependencies [a94a2a1]
- Updated dependencies [cc1125e]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.16

## 0.1.0-beta.15

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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
- 1f8ad1b: Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 3ab6919: Store migration journal in ClickHouse instead of a local file. Migration state is now tracked per-environment via a `_chkit_migrations` table, enabling multi-environment deployments where staging and production independently track applied migrations.
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
