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
- `chkit pull` introspects live dictionaries (including `RANGE`/`SETTINGS` and all attribute modifiers) into typed schema files, preserving ClickHouse's `[HIDDEN]` password redaction on `SOURCE(...)` credentials. A `SOURCE(...)` password change diffs and migrates like any other field change; `chkit generate` warns when a literal password is about to be written into migration SQL as plain text. `chkit pull` warns in two cases: when an introspected password comes back as `[HIDDEN]` (chkit can't recover the real value, so that dictionary's `source` is excluded from future diffs until it's replaced), and when ClickHouse is configured to reveal real passwords on introspection (`display_secrets_in_show_and_select` + `displaySecretsInShowAndSelect`), since that writes a plain-text credential into the generated schema file with no other indication. All warnings print to the console and are included as a `warnings` array in `--json` output.
- `codegen` generates a typed interface (and optional Zod schema) for each dictionary from its `attributes`, always included regardless of `includeViews`.
- `ON CLUSTER` mode stamps `ON CLUSTER <name>` onto every dictionary DDL statement, including `CREATE OR REPLACE DICTIONARY` and `RENAME DICTIONARY`.
