---
"@chkit/plugin-backfill": patch
---

mv_replay backfills insert by column name, so a `SELECT *` view into a target with reordered columns or extra `DEFAULT`, `MATERIALIZED` or `ALIAS` columns now replays. Planning, `run` and `resume` fail with a clear error when the view's columns do not fit the target.
