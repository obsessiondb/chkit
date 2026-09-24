---
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"@chkit/core": patch
---

Fix `chkit pull` silently dropping a table's projections (and mangling its `ORDER BY`/`PRIMARY KEY`) when a column has a backtick-quoted name containing a parenthesis, e.g. `` `weird)name` `` (#196). The create-table body scanner counted that paren as structure, truncating the parse.

The root cause was four separate copies of "scan SQL while ignoring quoted regions", which had already drifted — one tracked no quotes at all, another missed backticks (#197). They now share a single quote-aware primitive (`nextQuote`) in `@chkit/core`, alongside shared `stripWrappingParens` and `findMatchingParen` helpers, so the rule lives in one place and every scanner (`splitTopLevelComma`, the projection index normalizer, the pull key-clause parser, and the create-table body finder) handles single-quoted strings, double-quoted identifiers, and backtick identifiers identically.
