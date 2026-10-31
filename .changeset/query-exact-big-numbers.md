---
"chkit": patch
"@chkit/clickhouse": patch
---

`chkit query` no longer rounds 64-bit and wider integers and Decimals (#381). ClickHouse writes them as bare JSON numbers, and `JSON.parse` read them as doubles: `UInt64` max printed as `18446744073709552000`, `Int128` max as `1.7014118346046923e+38`, and a `Decimal128(9)` lost its fraction, in `--json` and in the table. `queryJson` now parses the response without losing digits and, in every column whose type is or contains `Int64`/`UInt64`, a 128/256-bit integer, a `Decimal`, `JSON`, `Object` or `Dynamic`, returns each number as a string of the digits ClickHouse sent. It sends no settings, so this works for a `readonly = 1` user too. The table output reads through `queryJson` as well. **Behaviour change:** in `--json` output those values are JSON strings now (they were numbers), also inside arrays, maps and tuples; `meta[].type` still gives the type. The envelope starts with `data`, then `meta`, as through an ObsessionDB service and in chkit-py.
