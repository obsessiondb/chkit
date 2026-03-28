---
"@chkit/plugin-backfill": patch
"@chkit/clickhouse": patch
"chkit": patch
---

Replace sequential backfill execution with async query submission and server-side polling. Chunks are submitted as fire-and-forget queries to ClickHouse and polled via `system.processes`/`system.query_log`, with configurable concurrency (`--concurrency`) and poll interval (`--poll-interval`). Removes the old synchronous executor, runtime, simulation flags, compatibility tokens, and event logging.
