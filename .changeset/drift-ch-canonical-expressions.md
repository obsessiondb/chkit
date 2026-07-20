---
"@chkit/clickhouse": patch
"chkit": patch
---

`chkit drift` no longer reports false drift when a schema expression is spelled differently from how ClickHouse stores it. ClickHouse reformats expressions on the way in — spacing argument separators and operators, adding precedence parentheses, and rewriting `INTERVAL 5 YEAR` to `toIntervalYear(5)` — so a skip index, `PARTITION BY`, `ORDER BY`, or `TTL` written as `cityHash64(a,b)` was stored as `cityHash64(a, b)` and reported as permanent drift that no migration could fix (#195).

`drift` now normalizes expressions through ClickHouse's own formatter (`formatQuerySingleLine`) before comparing, in a single batched round-trip, so equivalent expressions match regardless of spelling. When the connected server can't format a fragment — an older server without the function, or an expression it can't parse — that fragment falls back to plain text comparison, so behavior is never worse than before. `@chkit/clickhouse` gains `canonicalizeSqlFragments` for this.
