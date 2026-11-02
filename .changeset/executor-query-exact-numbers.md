---
"@chkit/clickhouse": patch
"@chkit/plugin-backfill": patch
---

`executor.query()` no longer rounds 64-bit and wider integers and Decimals. A number that a JavaScript double cannot hold exactly (for example `toUInt64(18446744073709551615)` or a `Decimal128` with 20 digits) now arrives as a string of the digits ClickHouse sent, instead of a silently rounded number. Every other number, Float64 included, is still a number. The internal reads of `status`, `check`, `drift`, `pull`, backfill and ingest are unaffected.
