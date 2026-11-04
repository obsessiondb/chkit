---
"@chkit/clickhouse": patch
"@chkit/plugin-backfill": patch
---

`executor.query()` returns 64-bit and wider integers and Decimals that a double cannot hold exactly as strings of their digits instead of rounded numbers.
