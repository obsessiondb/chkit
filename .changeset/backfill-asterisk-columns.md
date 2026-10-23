---
"@chkit/plugin-backfill": patch
---

Backfill chunk INSERTs now set `asterisk_include_materialized_columns=0` and `asterisk_include_alias_columns=0`. Before, a settings profile that enabled them made `SELECT *` return MATERIALIZED and ALIAS columns: copy backfills failed with a column-count mismatch, and an mv_replay of a `SELECT *` view could write values into the wrong target columns. Local runs and ObsessionDB managed submit both use the fixed SQL.
