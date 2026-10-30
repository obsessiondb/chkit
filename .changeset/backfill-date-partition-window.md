---
"@chkit/plugin-backfill": patch
---

Fix `chkit plugin backfill plan --from/--to` for tables partitioned on a `Date` column (#352). `system.parts` reports `min_time`/`max_time` as 1970-01-01 for those tables and fills `min_date`/`max_date` instead, so any `--from` selected nothing ("No partitions found … The table may be empty"), `--to` alone selected everything, and the plan's `from`/`to` were the epoch. The planner now falls back to `min_date`/`max_date` (a partition's last day ends at 23:59:59), so the window selects the partitions it overlaps.
