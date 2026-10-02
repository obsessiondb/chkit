---
"@chkit/core": patch
"@chkit/codegen": patch
"@chkit/clickhouse": patch
"chkit": patch
"@chkit/plugin-pull": patch
"@chkit/plugin-codegen": patch
"@chkit/plugin-backfill": patch
---

Support `MATERIALIZED`, `ALIAS`, and `EPHEMERAL` column expressions with `defaultKind`, preserving kinds through SQL rendering, pull, snapshots, and drift. Keep existing defaults and snapshots stable; use the existing `fn:` prefix for SQL expressions and allow expressionless `EPHEMERAL` columns.

Generate separate row and insert shapes for tables with special column kinds. Exclude generated columns from automatic backfill insert projections and reject automatic backfills that cannot reconstruct ephemeral inputs. Emit explicit removal of stored expressions, reject automatic storage-kind conversions involving `ALIAS` or `EPHEMERAL`, and never automatically rewrite historical materialized values.

Compare defaults with quote-aware SQL tokens, preserving literal whitespace and distinguishing SQL expressions from string literals. Generate `Row` for default `SELECT *`, `RowExplicit` for all readable columns, and `RowInsert` for writes. Verify live column kinds during backfill planning and local execution, and fail closed on unavailable metadata. Surface historical-value warnings in CLI output and migration files.
