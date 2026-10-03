---
"chkit": patch
"@chkit/clickhouse": patch
---

`chkit migrate` now waits after each view and materialized view statement until the object appears in `system.tables` (or, after a drop, disappears from it), as it already did for tables and dictionaries (#231). Before, the next statement could run before the previous view statement had propagated on managed ClickHouse environments (e.g. ObsessionDB), so a view created right after the view it reads could still fail with `Unknown table expression identifier`. The wait now escapes object names, so a table, view, dictionary or column whose name contains a quote or a backslash no longer fails `migrate` with a syntax error after its statement has run. `migrate` also reads operation keys whose names contain spaces; before, such a name shifted the next operation onto its statement, so `migrate` waited for an object that did not exist yet. The wait now reads names that contain `:` in full. Before, it cut them at the `:`, so `migrate` failed after the statement on such a table, dictionary or column had run, and a drop of such an object did not wait at all.
