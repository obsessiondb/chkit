---
"chkit": patch
"@chkit/clickhouse": patch
---

`migrate` is safe on multi-replica targets such as multi-replica ObsessionDB services: it waits for each DDL change on every replica and reads the newest journal row across replicas, so a lagging replica can no longer lose a change or replay a completed statement (#265).
