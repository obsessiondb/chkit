---
"@chkit/plugin-backfill": patch
---

Refactor the backfill chunk-SQL rewriter (`chunking/sql.ts`): fold the duplicated quote/paren-aware scan loops into one shared `scanSqlTokens` primitive (with `findTopLevelKeywords`/`splitTopLevel` on top) and split the oversized `rewriteSelectColumns` into focused helpers. Behavior is unchanged — the same customer SQL rewriting is now covered by direct unit tests for quoted-string, escaped-quote, nested-subquery, and missing-FROM edge cases.
