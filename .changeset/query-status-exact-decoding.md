---
"@chkit/clickhouse": patch
---

`queryStatus()` decodes its rows the same way as `executor.query()`; the returned `QueryStatus` is unchanged.
