---
"chkit": patch
---

The first statement of a newly generated cutover forces `skip_unavailable_shards = 0` when `clickhouse.cluster` is set, so an unreachable replica fails validation even if the connection enables skipping.
