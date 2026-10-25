---
"chkit": patch
"@chkit/clickhouse": patch
"@chkit/codegen": patch
"create-chkit": patch
"@chkit/plugin-backfill": patch
"@chkit/plugin-codegen": patch
"@chkit/plugin-ingest": patch
"@chkit/plugin-obsessiondb": patch
"@chkit/plugin-pull": patch
---

Move internal execution orchestration to Effect while retaining ordinary Promise, AsyncIterable, AbortSignal, and Zod extension APIs and runtime-independent generated application code. Scope nested plugin work and owned connections, bound abandoned executor cleanup, serialize backfill progress publication, and reject invalid programmatic ingestion capacities before work starts. Correct pre-existing SQL/LIKE escaping for backfill plan identifiers containing backslashes, quotes or wildcard characters.
