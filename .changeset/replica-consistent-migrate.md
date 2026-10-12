---
"chkit": patch
"@chkit/clickhouse": patch
---

Make `migrate` safe on multi-replica targets such as multi-replica ObsessionDB services (#265). After each DDL statement it waits until every replica shows the change, not just the one that answered, so a following `ALTER` can no longer run on a lagging replica and lose the previous change. Journal reads take the newest row per migration across all replicas, so a lagging replica can no longer make `migrate` replay a completed statement. The replica count comes from `clusterAllReplicas` on `clickhouse.cluster` (or `default`); single-replica and self-hosted targets keep the previous behavior.
