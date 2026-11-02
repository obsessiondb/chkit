---
"chkit": patch
"@chkit/clickhouse": patch
---

`chkit query` keeps numbers in `JSON`, `Object` and `Dynamic` columns as numbers (#438). Since #381 every number in a column whose type is or contains one of them was a string, floats and small integers included: `CAST('{"a": 2.5, "b": [1, 0.1]}' AS JSON)` printed `{"a":"2.5","b":["1","0.1"]}`. Inside these columns a number now becomes a string of the digits ClickHouse sent only when a double cannot hold it, by the rule `executor.query` uses (#425): `2.5`, `1` and `0.1` stay numbers, `18446744073709551615` and `123456789012345678.91` stay strings. This applies to `queryJson`, in `data`, `totals` and `extremes`, in the table and in `--json`. Columns of 64-bit and wider integer and Decimal types (not inside `JSON`, `Object` or `Dynamic`) still print every number as a string.
