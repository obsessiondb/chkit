---
"chkit": patch
---

Fix `migrate --apply` crashing against an ObsessionDB-managed service. The ObsessionDB workbench API returns every column value as a string, so the migration journal's `operations` (`Array(Tuple)`) column arrived as text and `migration_completed` arrived as `"true"`/`"false"` — causing `(row.operations ?? []).map is not a function` and a `Boolean("false") === true` mis-read. The journal now reads `operations` via `toJSONString(...)` + `JSON.parse` and parses the boolean explicitly, which round-trips identically through both the native ClickHouse client and the remote executor (no journal schema change).
