---
"chkit": patch
"@chkit/clickhouse": patch
"@chkit/plugin-obsessiondb": patch
---

Read an async `migrate` statement's status on every replica of a multi-replica target such as a multi-replica ObsessionDB service (#246). The query runs only on the replica that received it, so the check for a still-running attempt could miss it, resubmit with the same query id (`QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING`) and run the statement's `-- before-retry:` SQL while the attempt was still writing. `queryStatus` in the native and ObsessionDB remote executors now reads `system.processes` and `system.query_log` through `clusterAllReplicas` when the target has more than one replica, also without `clickhouse.cluster`. The in-flight check fails when a replica cannot be read, before any before-retry SQL runs or the statement is resubmitted; polls skip an unreachable replica as before.
