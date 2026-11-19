---
"@chkit/plugin-backfill": patch
---

A backfill chunk into a `Distributed` table is no longer marked done while its rows are still queued on the initiator: every chunk INSERT now runs with `distributed_foreground_insert = 1`, so it returns only once its rows reached the shards.
