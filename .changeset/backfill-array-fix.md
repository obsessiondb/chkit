---
"@chkit/plugin-backfill": patch
---

Fix: Backfill no longer fails with "Array(String) cannot be inside Nullable column" error when replaying materialized views that compute array columns. The plugin now injects time-range filters directly into the MV query instead of wrapping it in a CTE, avoiding ClickHouse's illegal type inference.
