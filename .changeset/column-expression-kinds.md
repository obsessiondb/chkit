---
"@chkit/core": minor
"@chkit/codegen": patch
"@chkit/clickhouse": minor
"chkit": minor
"@chkit/plugin-pull": minor
"@chkit/plugin-codegen": minor
"@chkit/plugin-backfill": patch
---

Support `MATERIALIZED`, `ALIAS`, and `EPHEMERAL` column expressions with `defaultKind`, preserving kinds through SQL rendering, pull, snapshots, and drift. Keep existing defaults and snapshots stable; use the existing `fn:` prefix for SQL expressions and allow expressionless `EPHEMERAL` columns.

Generate separate row and insert shapes for tables with special column kinds. Exclude generated columns from automatic backfill insert projections and reject automatic backfills that cannot reconstruct ephemeral inputs. Emit explicit removal of stored expressions, require manual migrations for storage-kind conversions involving `ALIAS` or `EPHEMERAL`, and never automatically rewrite historical materialized values.

Compare defaults with quote-aware SQL tokens, preserving literal whitespace and distinguishing SQL expressions from string literals. Generate `Row` for default `SELECT *`, `RowExplicit` for all readable columns, and `RowInsert` for writes. Verify live column kinds during backfill planning and local execution, fail closed on unavailable metadata, and provide `generate --reconcile --table` for verified snapshot adoption after manual column migrations. Surface historical-value warnings in CLI output and migration files.
