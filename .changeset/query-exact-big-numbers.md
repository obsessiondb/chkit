---
"chkit": patch
"@chkit/plugin-obsessiondb": patch
---

`chkit query` no longer rounds 64-bit and wider integers and Decimals (#381). It sends `output_format_json_quote_64bit_integers = 1` and `output_format_json_quote_decimals = 1`, so ClickHouse writes them as strings instead of bare JSON numbers that `JSON.parse` read as doubles: `UInt64` max printed as `18446744073709552000`, `Int128` max as `1.7014118346046923e+38`, and a `Decimal128(9)` lost its fraction. Both the `--json` output and the table output are affected. **Behaviour change:** in `--json` output, `UInt64`, `Int64`, 128/256-bit integer and `Decimal` values are JSON strings now (they were numbers); `meta[].type` still gives the type. The ObsessionDB remote executor now sends `queryJson` settings to the console API instead of dropping them.
