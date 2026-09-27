---
"@chkit/core": minor
"@chkit/clickhouse": minor
"chkit": minor
"@chkit/plugin-pull": minor
"@chkit/plugin-codegen": minor
"@chkit/plugin-backfill": patch
---

Support `MATERIALIZED`, `ALIAS`, and `EPHEMERAL` column expressions with `defaultKind`, preserving kinds through SQL rendering, pull, snapshots, and drift. Keep existing defaults and snapshots stable; use the existing `fn:` prefix for SQL expressions and allow expressionless `EPHEMERAL` columns.

Generate separate row and insert shapes for tables with special column kinds. Exclude generated columns from automatic backfill insert projections and reject automatic backfills that cannot reconstruct ephemeral inputs. Emit explicit removal of stored expressions, require manual migrations for storage-kind conversions involving `ALIAS` or `EPHEMERAL`, and never automatically rewrite historical materialized values.
