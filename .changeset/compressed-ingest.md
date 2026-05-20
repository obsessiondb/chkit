---
"@chkit/clickhouse": patch
"@chkit/plugin-codegen": patch
"chkit": patch
---

Add opt-in `compressed` flag to `ClickHouseExecutor.insert` that routes inserts through a separate client with gzip request-body compression. Generated ingest helpers from `@chkit/plugin-codegen` now accept an `IngestOptions` argument and gzip-compress request bodies by default; pass `{ compressed: false }` as the third argument to opt out per call.
