---
"chkit": patch
"@chkit/clickhouse": patch
---

`chkit drift` and `chkit check` now compare each view's and materialized view's query and `TO` target with the live ones, reporting `query_mismatch` or `target_mismatch` (#382). `drift` no longer falls back to plain text matching after "Session is locked by a concurrent client".
