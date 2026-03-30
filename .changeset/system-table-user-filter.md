---
"@chkit/clickhouse": patch
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

Add `user = currentUser()` filter to all system.processes and system.query_log queries to satisfy ClickHouse row-level security policies.
