---
"@chkit/plugin-backfill": patch
---

mv_replay backfills now write each target column by name, the way ClickHouse does when a materialized view inserts into its `TO` table. `backfill plan` reads the live target's insertable columns and each view's output columns, and saves the matching list in the plan; every chunk renders it on both sides of `INSERT … SELECT`. A `SELECT *` view into a target with reordered columns or extra `DEFAULT`, `MATERIALIZED` or `ALIAS` columns now replays (before, it failed with "Number of columns doesn't match" or an unknown identifier). Planning fails clearly when a view outputs a column the target cannot take, or when views feeding one target output different columns, and `run`/`resume` refuse a plan whose target lost a planned column. ObsessionDB managed submit uses the same SQL.
