---
"chkit": patch
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"@chkit/plugin-codegen": patch
---

Add `dictionary()` as a first-class ClickHouse schema primitive, mirroring `materializedView()` across the full lifecycle: DSL authoring, validation, canonicalization, SQL rendering, migration planning/diff, drift, `check`, destructive-op safety, `pull` introspection, and `codegen` typed interfaces.

- `dictionary({ database, name, attributes, primaryKey, source, layout, lifetime, range?, settings?, comment? })` — attributes support `default`/`expression` (mutually exclusive), `hierarchical`, `bidirectional` (requires `hierarchical`), `injective`, and `isObjectId`. `range: { min, max }` renders `RANGE(MIN ... MAX ...)` for `RANGE_HASHED`/`COMPLEX_KEY_RANGE_HASHED` layouts, and `settings` renders `SETTINGS(...)`.
- ClickHouse has no `ALTER DICTIONARY`, so any structural change plans a single atomic `CREATE OR REPLACE DICTIONARY`. Dropping a dictionary is treated as destructive and blocked without `--allow-destructive`.
- Set `renamedFrom` on a dictionary (or pass `--rename-dictionary old_db.old=new_db.new` to `chkit generate`) to rename a dictionary via `RENAME DICTIONARY IF EXISTS ... TO ...` instead of a destructive drop + create.
- `chkit pull` introspects live dictionaries (including `RANGE`/`SETTINGS` and all attribute modifiers) into typed schema files, preserving ClickHouse's `[HIDDEN]` password redaction on `SOURCE(...)` credentials; the planner masks passwords before diffing so a live `[HIDDEN]` value never shows as perpetual drift.
- `codegen` generates a typed interface (and optional Zod schema) for each dictionary from its `attributes`, always included regardless of `includeViews`.
- `ON CLUSTER` mode now correctly stamps every dictionary DDL statement, including `CREATE OR REPLACE DICTIONARY` and `RENAME DICTIONARY`.
