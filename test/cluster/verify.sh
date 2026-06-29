#!/usr/bin/env bash
# Smoke-test the local cluster: ON CLUSTER create + cross-replica replication.
# Exits non-zero on failure. Run via `bun run cluster:verify`.
set -euo pipefail

CH1=(docker exec chkit-ch1 clickhouse-client --password clusterpass)
CH2=(docker exec chkit-ch2 clickhouse-client --password clusterpass)
T="default.chkit_cluster_smoke"

echo "==> cluster topology (test_cluster)"
"${CH1[@]}" -q "SELECT host_name, shard_num, replica_num FROM system.clusters WHERE cluster='test_cluster' ORDER BY replica_num FORMAT PrettyCompactMonoBlock"

echo "==> ON CLUSTER create + replicate ch1 -> ch2"
"${CH1[@]}" --multiquery -q "
DROP TABLE IF EXISTS $T ON CLUSTER test_cluster SYNC;
CREATE TABLE $T ON CLUSTER test_cluster (id UInt64) ENGINE = ReplicatedMergeTree ORDER BY id;
INSERT INTO $T VALUES (1),(2),(3);
" >/dev/null

"${CH2[@]}" -q "SYSTEM SYNC REPLICA $T" >/dev/null
COUNT="$("${CH2[@]}" -q "SELECT count() FROM $T")"
"${CH1[@]}" -q "DROP TABLE IF EXISTS $T ON CLUSTER test_cluster SYNC" >/dev/null

if [ "$COUNT" = "3" ]; then
  echo "PASS: 3 rows replicated ch1 -> ch2"
else
  echo "FAIL: expected 3 rows on ch2, got '$COUNT'" >&2
  exit 1
fi
