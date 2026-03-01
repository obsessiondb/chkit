---
"@chkit/plugin-backfill": patch
---

Fix backfill MV replay SQL generation to include explicit column list in INSERT clause, avoiding positional column mismatches when the materialized view uses SELECT * and adds computed columns.
