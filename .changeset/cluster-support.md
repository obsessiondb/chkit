---
"chkit": patch
"@chkit/core": patch
---

Add ClickHouse cluster support. Set `clickhouse.cluster` in your config to run all generated DDL `ON CLUSTER <name>` and store the migration journal in a replicated engine — for self-managed multi-node clusters. Your table engines are passed through unchanged (declare `ReplicatedMergeTree` yourself). Leave `cluster` unset for single-node, ClickHouse Cloud, or ObsessionDB, where replication is automatic and `ON CLUSTER` is unnecessary.
