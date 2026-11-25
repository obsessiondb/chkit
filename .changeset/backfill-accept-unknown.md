---
"@chkit/plugin-backfill": patch
---

`backfill run`, `resume` and `cancel` lock the plan to prevent duplicate submissions, while resume tracks each replay separately and retries only attempts proven to have failed before writing rows; uncertain outcomes stop with the query ID and require `--accept-unknown` to replay. Chunk inserts disable parallel replica and distributed INSERT SELECT execution and require full query logging to prevent replaying partially written data, including on older ClickHouse versions.
