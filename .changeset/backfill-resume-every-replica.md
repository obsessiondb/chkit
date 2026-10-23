---
"@chkit/plugin-backfill": patch
---

`backfill resume` now reads chunk status on every replica of a multi-replica target such as a multi-replica ObsessionDB service, also without `clickhouse.cluster` (#289). A chunk query runs only on the replica that received it, so the resume check could miss a chunk still running (or finished) on another replica and submit it again. `syncProgress` reads `system.processes` and `system.query_log` through `clusterAllReplicas` when the target has more than one replica, and fails without submitting anything when a replica cannot be read. `executeBackfill` takes the configured `cluster`.
