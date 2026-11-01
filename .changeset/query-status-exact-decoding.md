---
"@chkit/clickhouse": patch
---

`queryStatus()` now decodes its `system.processes` and `system.query_log` rows the same way as `executor.query()` (#436), instead of with the client's plain `JSON.parse`. Its internal row types now say what arrives: a UInt64 count is a number, or a string of its digits beyond 2^53 or when the profile sets `output_format_json_quote_64bit_integers`. The returned `QueryStatus` is unchanged: its counts are still numbers.
