# @chkit/plugin-typegen

## 0.1.2-beta.0

### Patch Changes

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.0

## 0.1.1

### Patch Changes

- Updated dependencies [6b87e6d]
  - @chkit/core@0.1.1

## 0.1.0

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- dfaa8fa: Consolidate all publishable packages on Zod 4. `@chkit/plugin-obsessiondb` was pinned to `zod@3.25.76` while the rest of the toolkit used Zod 4, pulling two major versions into the dependency tree; it now uses `zod@^4.3.6`. Its oRPC contracts are unaffected — `@orpc/contract` validates through the Standard Schema interface, which both Zod majors implement. `@chkit/plugin-codegen` now declares `zod` as a peer dependency (`^4.0.0`) instead of a direct dependency, so generated Zod schemas resolve against the consumer's own `zod` install rather than a bundled copy.
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

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
- 9a54433: Add CODE_OF_CONDUCT.md and SECURITY.md governance documents, .env.example for development setup, and update package.json metadata for all packages.
- a3a09cf: Rename plugin-typegen to plugin-codegen and add ingestion functions.
- d983fdf: Rename internals and CLI binary from chkit to chkit.
- dfaa8fa: Consolidate all publishable packages on Zod 4. `@chkit/plugin-obsessiondb` was pinned to `zod@3.25.76` while the rest of the toolkit used Zod 4, pulling two major versions into the dependency tree; it now uses `zod@^4.3.6`. Its oRPC contracts are unaffected — `@orpc/contract` validates through the Standard Schema interface, which both Zod majors implement. `@chkit/plugin-codegen` now declares `zod` as a peer dependency (`^4.0.0`) instead of a direct dependency, so generated Zod schemas resolve against the consumer's own `zod` install rather than a bundled copy.
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

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
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
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.28

## 0.1.0-beta.27

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
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
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.27

## 0.1.0-beta.26

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
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
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.26

## 0.1.0-beta.25

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
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
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.25

## 0.1.0-beta.24

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
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
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.24

## 0.1.0-beta.23

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
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
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.23

## 0.1.0-beta.22

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- ffdcdb9: Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
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
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.22

## 0.1.0-beta.21

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
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
- Updated dependencies [b0f200d]
- Updated dependencies [a77c5b2]
- Updated dependencies [a3a09cf]
- Updated dependencies [d983fdf]
- Updated dependencies [b0f200d]
- Updated dependencies [a52a2b2]
  - @chkit/core@0.1.0-beta.21

## 0.1.0-beta.20

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
- b7f396a: Use ReplacingMergeTree(applied_at) instead of MergeTree() for the \_chkit_migrations journal table. This ensures the FINAL keyword works correctly on managed ClickHouse environments (e.g. ObsessionDB), where SharedMergeTree does not support FINAL but SharedReplacingMergeTree does.
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
  - @chkit/core@0.1.0-beta.20

## 0.1.0-beta.19

### Patch Changes

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- 1a5caa3: Move `loadSchemaDefinitions` out of the `@chkit/core` barrel export into a dedicated `@chkit/core/schema-loader` subpath. This removes the transitive `fast-glob` -> `node:os` dependency from the main entry point, making `@chkit/core` safe to import in non-Node runtimes like Cloudflare Workers (workerd). The `./utils` subpath is removed since `extractExecutableStatements` is now available directly from `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
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

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- c396fb5: Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
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

- c63c74f: Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
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
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- 2eaaa5a: Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
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
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
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
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
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
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
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
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
- f719c50: Fix workspace:\* dependencies in published packages. Restores manual workspace version resolution before publish due to a bun publish bug (oven-sh/bun#24687) where workspace:\* references are not resolved in the published tarball.
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
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
- a94a2a1: Move flag parsing and shared types to @chkit/core, split plugin-codegen into focused modules, and resolve lint warnings.
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
  - @chkit/core@0.1.0-beta.10

## 0.1.0-beta.9

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
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
  - @chkit/core@0.1.0-beta.9

## 0.1.0-beta.8

### Patch Changes

- ba60638: Add homepage and repository metadata to all packages, and link READMEs to the chkit CLI package and documentation site.
- a94a2a1: Replace @stricli/core with a custom CLI framework, migrate plugins to declared flags, and refine the plugin API and error handling.
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
