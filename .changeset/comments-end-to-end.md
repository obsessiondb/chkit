---
"chkit": patch
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"@chkit/plugin-obsessiondb": patch
---

Comments work end to end (#464). Comments escape backslashes, so ClickHouse stores the exact text (a trailing `\` no longer breaks the statement), and an empty comment is the same as none. A table comment change plans `ALTER TABLE ... MODIFY COMMENT`; a view, materialized view or dictionary comment change is the same `MODIFY COMMENT` instead of a drop and recreate (or `CREATE OR REPLACE DICTIONARY`). A column comment change alone is `COMMENT COLUMN`, and a removed column comment runs `MODIFY COLUMN ... REMOVE COMMENT`, so it no longer stays on the server. `drift` reports a changed table, view, materialized view or dictionary comment as `comment_mismatch`, with both values. `pull` writes the comments of tables, views and materialized views, reads every comment from `system.tables.comment` (decoded by ClickHouse), finds the `AS` and `TO` of a view outside its `COMMENT`, and skips a materialized view with an inner table, and that table, with a warning. The same comments reach `drift` and `pull` when they run through the ObsessionDB console API.
