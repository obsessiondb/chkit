---
"@chkit/plugin-backfill": patch
---

Every `chkit plugin backfill` chunk INSERT now runs with `allow_experimental_parallel_reading_from_replicas = 0` (`enable_parallel_replicas` from 24.10 on), `parallel_distributed_insert_select = 0` and full query logging, so a failed chunk is never replayed on top of rows its replicas or shards wrote; a chunk INSERT that relied on parallel replicas, or on a Distributed INSERT SELECT running on the shards, now runs on the node that receives it, and a user who may not change those settings gets an error before anything is sent.
