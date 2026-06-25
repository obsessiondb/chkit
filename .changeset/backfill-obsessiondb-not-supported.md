---
"@chkit/plugin-obsessiondb": patch
---

Backfill `plan`/`run`/`resume` now refuse to run against ObsessionDB instead of silently opening a direct ClickHouse connection. When a service is selected, these commands will eventually submit jobs to the ObsessionDB backend; until that lands they error with a clear message pointing to `--local` for direct execution.
