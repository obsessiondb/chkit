---
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

Add `chkit backfill submit` to run a backfill as a managed ObsessionDB job. It builds the plan with the same chunking algorithm as the local `run`, submits the chunks to the ObsessionDB job backend, and prints a console link to track progress instead of polling locally — the heavier, MV-replay-aware path lives in the ObsessionDB plugin. The plugin's remote executor now forwards ClickHouse query settings (e.g. `enable_parallel_replicas`) so remote plan sizing matches the local planner.
