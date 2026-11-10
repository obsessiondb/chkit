Comments work end to end, as in TS (#464). Comments escape backslashes, so ClickHouse
stores the exact text (a trailing `\` no longer breaks the statement), and an empty
comment is the same as none. A table, view, materialized view or dictionary comment change
plans `ALTER TABLE ... MODIFY COMMENT` (no drop and recreate, no `CREATE OR REPLACE
DICTIONARY`); a column comment change alone is `COMMENT COLUMN`, and a removed column
comment runs `MODIFY COLUMN ... REMOVE COMMENT`. `drift` reports a changed object comment
as `comment_mismatch`, with both values. `pull` writes the comments of tables, views and
materialized views from `system.tables.comment`, finds a view's `AS` and `TO` outside its
`COMMENT`, writes non-ASCII text as is (an emoji was written as two lone surrogates), and
skips a materialized view with an inner table, and that table, with a warning.
