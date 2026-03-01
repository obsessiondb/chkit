---
"@chkit/plugin-backfill": patch
---

Fix: Execute backfill SQL against ClickHouse, detect materialized views, and use correct date parsing. The `executeBackfillRun` and `resumeBackfillRun` functions now accept an optional `execute` callback that is invoked for each chunk. The plugin wires this callback to the ClickHouse client in the `run` and `resume` commands. Additionally, the planner now detects materialized view targets in the schema and automatically generates CTE-wrapped replay SQL instead of incorrect INSERT-SELECT statements. Idempotency tokens are now wired as the `insert_deduplication_token` ClickHouse setting. Date parsing switched from `toDateTime` to `parseDateTimeBestEffort` for proper ISO 8601 timestamp handling.
