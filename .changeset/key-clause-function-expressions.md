---
"chkit": patch
"@chkit/core": patch
---

Support ClickHouse function expressions in `primaryKey`/`orderBy` (e.g. `toDate(ts)`, `toStartOfHour(session_end)`). Validation no longer reports `primary_key_missing_column`/`order_by_missing_column` for expression entries, and generated DDL emits them verbatim instead of quoting the whole expression as a column name. Plain column references are still validated and backtick-quoted as before.

Migration planning now compares key clauses independent of insignificant whitespace and identifier backtick-quoting, so an expression written as `toStartOfHour( ts )` or a column written bare as `user-id` no longer diffs against ClickHouse's normalized `toStartOfHour(ts)` / `` `user-id` `` and triggers a phantom table recreate on `migrate`/`drift`/`check`.
