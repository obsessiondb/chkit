---
"@chkit/plugin-backfill": patch
---

`backfill plan --from/--to` no longer selects a partition outside the window because one of its active parts reports `min_time = 1970-01-01` in `system.parts` (an empty part, e.g. left behind by a DELETE mutation). Partition introspection now ignores zero `min_time` values when it takes a partition's earliest time (#320).
