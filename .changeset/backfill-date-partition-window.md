---
"@chkit/plugin-backfill": patch
---

`chkit plugin backfill plan --from/--to` now selects the right partitions for tables partitioned on a `Date` column, instead of none or all of them (#352).
