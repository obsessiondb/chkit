---
"@chkit/plugin-backfill": patch
"@chkit/clickhouse": patch
"chkit": patch
---

Rewrite backfill chunk planning with multi-strategy smart chunking. The planner now introspects partition layout, sort key distribution, and row estimates to produce better-sized chunks using strategies like equal-width splitting, quantile ranges, temporal bucketing, string prefix splitting, and group-by-key splitting. Adds a dedicated `sdk` entry point for programmatic access to chunking internals.
