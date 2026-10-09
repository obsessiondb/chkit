---
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"@chkit/core": patch
---

Fix `chkit pull` leaving a key tuple wrapped (`orderBy: ["(\`w)x\`, id)"]` instead of `["\`w)x\`", "id"]`) when a key column has a quoted name containing a parenthesis. The pull plugin had its own paren-stripper that ignored quotes; it now uses the shared `stripWrappingParens` from `@chkit/core`.

The quote-aware SQL scanners (`splitTopLevelComma`, `stripWrappingParens`, the projection index normalizer, `findTopLevelSQLPattern`, and the create-table column-list finder) now share a single quote skipper, `findQuoteEnd`, so backslash escapes and doubled quotes are handled identically everywhere (#197). Previously `stripWrappingParens` and the projection index normalizer mis-read a string ending in an escaped backslash (`'a\\'`).
