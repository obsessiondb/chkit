---
"@chkit/core": patch
---

`generate` no longer fails on a refreshable materialized view without `APPEND` that targets a `Replicated*` table. ObsessionDB, ClickHouse Cloud and `Replicated` databases accept replace-mode refreshes, so chkit now only warns that a non-replicated (`Atomic`) database refuses them.
