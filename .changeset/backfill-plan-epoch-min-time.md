---
"@chkit/plugin-backfill": patch
---

`backfill plan --from/--to` no longer selects a partition outside the window because an empty part, for example one left by a DELETE mutation, reports a 1970 `min_time` (#320).
