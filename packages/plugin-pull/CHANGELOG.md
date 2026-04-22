# @chkit/plugin-pull

## 0.1.0-beta.21

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
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
  - `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that ClickHouse Cloud auto-injects.
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
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
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
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
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
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
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
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
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
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- cc1125e: Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
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
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
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
  - @chkit/core@0.1.0-beta.15

## 0.1.0-beta.14

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
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [bc0c6b1]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.14
  - @chkit/core@0.1.0-beta.14

## 0.1.0-beta.13

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
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.13
  - @chkit/core@0.1.0-beta.13

## 0.1.0-beta.12

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
- Updated dependencies [1f8ad1b]
- Updated dependencies [f719c50]
- Updated dependencies [a94a2a1]
- Updated dependencies [3ab6919]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.12
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
- Updated dependencies [3ab6919]
- Updated dependencies [9a54433]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.11
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
- Updated dependencies [3ab6919]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.10
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
- Updated dependencies [3ab6919]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
  - @chkit/clickhouse@0.1.0-beta.9
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
  - @chkit/clickhouse@0.1.0-beta.8
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
  - @chkit/core@0.1.0-beta.4

## 0.1.0-beta.3

### Patch Changes

- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- Updated dependencies [a3a09cf]
  - @chkit/clickhouse@0.1.0-beta.3
  - @chkit/core@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- Updated dependencies [f719c50]
  - @chkit/clickhouse@0.1.0-beta.2
  - @chkit/core@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- Rename internals and CLI binary from chkit to chkit.
- Updated dependencies
  - @chkit/clickhouse@0.1.0-beta.1
  - @chkit/core@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- Initial beta release of the chkit ClickHouse schema and migration toolkit. Includes the CLI, core schema planner, codegen, ClickHouse client integration, and plugins for pull, typegen, and backfill.

### Patch Changes

- Updated dependencies
  - @chkit/clickhouse@0.1.0-beta.0
  - @chkit/core@0.1.0-beta.0
