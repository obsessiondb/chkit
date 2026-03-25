---
"@chkit/clickhouse": patch
"chkit": patch
---

Add X-DDL HTTP header to pin ClickHouse requests to a single node during migrations, fixing SharedMergeTree DDL race conditions.
