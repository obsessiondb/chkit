---
"@chkit/plugin-backfill": patch
---

Backfill chunks no longer break when a settings profile makes `SELECT *` include MATERIALIZED and ALIAS columns, which failed copy backfills and could write mv_replay values into the wrong target columns.
