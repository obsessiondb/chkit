# @chkit/plugin-codegen

## 0.2.0-beta.10

### Patch Changes

- @chkit/core@0.2.0-beta.10

## 0.2.0-beta.9

### Patch Changes

- 2f53550: Support `MATERIALIZED`, `ALIAS`, and `EPHEMERAL` columns with a new `defaultKind` column field. `default` holds the value or `fn:` expression for every kind, and `EPHEMERAL` may omit it. SQL rendering, `pull`, snapshots, and drift keep the kind; validation reports `column_expression_required` and `column_default_kind_invalid`.

  - `DEFAULT`/`MATERIALIZED` expression changes emit `MODIFY COLUMN` with a warning that stored values are not rewritten, and removed expressions emit `REMOVE DEFAULT`/`REMOVE MATERIALIZED`. Conversions to or from `ALIAS`/`EPHEMERAL` fail `generate` with `column_kind_change_unsupported`.
  - Codegen emits `Row` (`SELECT *`), `RowExplicit` (all readable columns), and `RowInsert` (all insertable columns) for these tables; ingest helpers take `RowInsert`.
  - Inserts into tables with `EPHEMERAL` columns name their columns: generated ingest helpers pass `columns`, which `@chkit/clickhouse` `insert()` and the ObsessionDB remote executor send, and the `@chkit/plugin-ingest` destination does the same.
  - Automatic backfills omit `MATERIALIZED` and `ALIAS` columns and check live column kinds first: a copy is blocked only when the target has both `EPHEMERAL` and `MATERIALIZED` columns, `mv_replay` by any `EPHEMERAL` column, and a missing target fails with "does not exist or is not visible yet".
  - `drift` and `check` compare defaults token by token. Write expressions in the canonical form ClickHouse stores, such as `CAST(x, 'String')`, to avoid drift.
  - Fix string defaults containing backslashes: `C:\temp` now renders as `DEFAULT 'C:\\temp'`.

- Updated dependencies [d072fe3]
- Updated dependencies [2f53550]
- Updated dependencies [98e3667]
- Updated dependencies [96a18c6]
- Updated dependencies [46cbf88]
- Updated dependencies [b59fc83]
- Updated dependencies [c49f0a9]
- Updated dependencies [672d67e]
  - @chkit/core@0.2.0-beta.9

## 0.2.0-beta.8

### Patch Changes

- 65c90d6: Add `dictionary()` as a first-class ClickHouse schema primitive, mirroring `materializedView()` across the full lifecycle: DSL authoring, validation, canonicalization, SQL rendering, migration planning/diff, drift, `check`, destructive-op safety, `pull` introspection, and `codegen` typed interfaces.

  - `dictionary({ database, name, attributes, primaryKey, source, layout, lifetime, range?, settings?, comment? })` — attributes support `default`/`expression` (mutually exclusive), `hierarchical`, `bidirectional` (requires `hierarchical`), `injective`, and `isObjectId`. `range: { min, max }` renders `RANGE(MIN ... MAX ...)` for `RANGE_HASHED`/`COMPLEX_KEY_RANGE_HASHED` layouts, and `settings` renders `SETTINGS(...)`.
  - ClickHouse has no `ALTER DICTIONARY`, so any structural change plans a single atomic `CREATE OR REPLACE DICTIONARY`. Dropping a dictionary is treated as destructive and blocked without `--allow-destructive`.
  - Set `renamedFrom` on a dictionary (or pass `--rename-dictionary old_db.old=new_db.new` to `chkit generate`) to rename a dictionary via `RENAME DICTIONARY IF EXISTS ... TO ...` instead of a destructive drop + create.
  - `chkit pull` introspects live dictionaries (including `RANGE`/`SETTINGS` and all attribute modifiers) into typed schema files, preserving ClickHouse's `[HIDDEN]` password redaction on `SOURCE(...)` credentials. A `SOURCE(...)` password change diffs and migrates like any other field change; `chkit generate` warns when a literal password is about to be written into migration SQL as plain text. `chkit pull` warns in two cases: when an introspected password comes back as `[HIDDEN]` (chkit can't recover the real value, so that dictionary's `source` is excluded from future diffs until it's replaced), and when ClickHouse is configured to reveal real passwords on introspection (`display_secrets_in_show_and_select` + `displaySecretsInShowAndSelect`), since that writes a plain-text credential into the generated schema file with no other indication. All warnings print to the console and are included as a `warnings` array in `--json` output.
  - `codegen` generates a typed interface (and optional Zod schema) for each dictionary from its `attributes`, always included regardless of `includeViews`.
  - `ON CLUSTER` mode stamps `ON CLUSTER <name>` onto every dictionary DDL statement, including `CREATE OR REPLACE DICTIONARY` and `RENAME DICTIONARY`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [65c90d6]
- Updated dependencies [3f1db03]
- Updated dependencies [f8238db]
- Updated dependencies [fedbf56]
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
- Updated dependencies [256ec62]
  - @chkit/core@0.2.0-beta.8

## 0.1.2-beta.7

### Patch Changes

- 65c90d6: Add `dictionary()` as a first-class ClickHouse schema primitive, mirroring `materializedView()` across the full lifecycle: DSL authoring, validation, canonicalization, SQL rendering, migration planning/diff, drift, `check`, destructive-op safety, `pull` introspection, and `codegen` typed interfaces.

  - `dictionary({ database, name, attributes, primaryKey, source, layout, lifetime, range?, settings?, comment? })` — attributes support `default`/`expression` (mutually exclusive), `hierarchical`, `bidirectional` (requires `hierarchical`), `injective`, and `isObjectId`. `range: { min, max }` renders `RANGE(MIN ... MAX ...)` for `RANGE_HASHED`/`COMPLEX_KEY_RANGE_HASHED` layouts, and `settings` renders `SETTINGS(...)`.
  - ClickHouse has no `ALTER DICTIONARY`, so any structural change plans a single atomic `CREATE OR REPLACE DICTIONARY`. Dropping a dictionary is treated as destructive and blocked without `--allow-destructive`.
  - Set `renamedFrom` on a dictionary (or pass `--rename-dictionary old_db.old=new_db.new` to `chkit generate`) to rename a dictionary via `RENAME DICTIONARY IF EXISTS ... TO ...` instead of a destructive drop + create.
  - `chkit pull` introspects live dictionaries (including `RANGE`/`SETTINGS` and all attribute modifiers) into typed schema files, preserving ClickHouse's `[HIDDEN]` password redaction on `SOURCE(...)` credentials. A `SOURCE(...)` password change diffs and migrates like any other field change; `chkit generate` warns when a literal password is about to be written into migration SQL as plain text. `chkit pull` warns in two cases: when an introspected password comes back as `[HIDDEN]` (chkit can't recover the real value, so that dictionary's `source` is excluded from future diffs until it's replaced), and when ClickHouse is configured to reveal real passwords on introspection (`display_secrets_in_show_and_select` + `displaySecretsInShowAndSelect`), since that writes a plain-text credential into the generated schema file with no other indication. All warnings print to the console and are included as a `warnings` array in `--json` output.
  - `codegen` generates a typed interface (and optional Zod schema) for each dictionary from its `attributes`, always included regardless of `includeViews`.
  - `ON CLUSTER` mode stamps `ON CLUSTER <name>` onto every dictionary DDL statement, including `CREATE OR REPLACE DICTIONARY` and `RENAME DICTIONARY`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [65c90d6]
- Updated dependencies [3f1db03]
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.7

## 0.1.2-beta.6

### Patch Changes

- 65c90d6: Add `dictionary()` as a first-class ClickHouse schema primitive, mirroring `materializedView()` across the full lifecycle: DSL authoring, validation, canonicalization, SQL rendering, migration planning/diff, drift, `check`, destructive-op safety, `pull` introspection, and `codegen` typed interfaces.

  - `dictionary({ database, name, attributes, primaryKey, source, layout, lifetime, range?, settings?, comment? })` — attributes support `default`/`expression` (mutually exclusive), `hierarchical`, `bidirectional` (requires `hierarchical`), `injective`, and `isObjectId`. `range: { min, max }` renders `RANGE(MIN ... MAX ...)` for `RANGE_HASHED`/`COMPLEX_KEY_RANGE_HASHED` layouts, and `settings` renders `SETTINGS(...)`.
  - ClickHouse has no `ALTER DICTIONARY`, so any structural change plans a single atomic `CREATE OR REPLACE DICTIONARY`. Dropping a dictionary is treated as destructive and blocked without `--allow-destructive`.
  - Set `renamedFrom` on a dictionary (or pass `--rename-dictionary old_db.old=new_db.new` to `chkit generate`) to rename a dictionary via `RENAME DICTIONARY IF EXISTS ... TO ...` instead of a destructive drop + create.
  - `chkit pull` introspects live dictionaries (including `RANGE`/`SETTINGS` and all attribute modifiers) into typed schema files, preserving ClickHouse's `[HIDDEN]` password redaction on `SOURCE(...)` credentials. A `SOURCE(...)` password change diffs and migrates like any other field change; `chkit generate` warns when a literal password is about to be written into migration SQL as plain text. `chkit pull` warns in two cases: when an introspected password comes back as `[HIDDEN]` (chkit can't recover the real value, so that dictionary's `source` is excluded from future diffs until it's replaced), and when ClickHouse is configured to reveal real passwords on introspection (`display_secrets_in_show_and_select` + `displaySecretsInShowAndSelect`), since that writes a plain-text credential into the generated schema file with no other indication. All warnings print to the console and are included as a `warnings` array in `--json` output.
  - `codegen` generates a typed interface (and optional Zod schema) for each dictionary from its `attributes`, always included regardless of `includeViews`.
  - `ON CLUSTER` mode stamps `ON CLUSTER <name>` onto every dictionary DDL statement, including `CREATE OR REPLACE DICTIONARY` and `RENAME DICTIONARY`.

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [65c90d6]
- Updated dependencies [3f1db03]
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.6

## 0.1.2-beta.5

### Patch Changes

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [3f1db03]
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.5

## 0.1.2-beta.4

### Patch Changes

- b501f5d: Extract shared plugin command scaffolding into `@chkit/core`: new `createPluginRunner` (binds a plugin's config-error class once and wraps command `run` handlers in the shared error-to-exit-code envelope) and `withFactoryDefaults` (layers plugin-factory options under parsed data). The backfill, codegen, and pull plugins now use these helpers instead of private copies — no behavior change, but the plugins require the matching `@chkit/core` version.
- Updated dependencies [5a8d805]
- Updated dependencies [b501f5d]
  - @chkit/core@0.1.2-beta.4
