---
"@chkit/core": patch
"@chkit/plugin-pull": patch
"@chkit/plugin-obsessiondb": patch
"chkit": patch
---

Support Distributed tables. `PARTITION BY`, `PRIMARY KEY` and `ORDER BY` are rendered
only for engines that accept them (the MergeTree family, EmbeddedRocksDB, KeeperMap,
S3 and a few others), so Distributed, Memory, Null, Log, Buffer and Merge tables
create cleanly, and setting a key on them fails validation with
`engine_unsupported_clause`. `table()` accepts these engines without `orderBy`, pull
writes them without keys, and Distributed engine arguments compare equal to the
quoted literals ClickHouse stores, so drift stays clean. Recreating a Distributed
table to change its engine arguments is `risk=caution`, since it holds no rows
(`danger` with `flush_on_detach = 0`). The ObsessionDB plugin rejects Distributed
tables at generate and check time when targeting ObsessionDB, which has no shards.
