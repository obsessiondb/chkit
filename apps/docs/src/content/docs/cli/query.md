---
title: "chkit query"
description: "Run a SQL query against the configured ClickHouse target."
sidebar:
  order: 10
---

Executes an ad-hoc SQL query against the configured target and prints the result.

## Synopsis

```
chkit query "<sql>" [flags]
```

The SQL must be a single positional argument. Wrap it in quotes if it contains spaces.

## Flags

No command-specific flags. See [global flags](/cli/overview/#global-flags).

When the [ObsessionDB plugin](/obsessiondb/overview/) is loaded, `chkit query`
also accepts `--service <name-or-alias>` to route the query to a specific service for
this invocation (see [Per-command override](/obsessiondb/services/#per-command-override)).

## Behavior

`chkit query` runs the SQL through whichever executor is active:

- Without any plugin override, it uses the `clickhouse` connection from your config.
- With the ObsessionDB plugin loaded, it routes the query to the selected service (or to the service named with `--service`).

The command requires an executor — if no `clickhouse` config is present and no plugin supplies one, it exits with an error.

`chkit query` sends no ClickHouse settings with the query, so a read-only user (`readonly = 1` or `readonly = 2`) can run it.

### Statements

`chkit query` reads the result in ClickHouse's `JSON` format, appending `FORMAT JSON` to the statement. A statement without a result set, such as `CREATE`, `DROP`, `OPTIMIZE` or `INSERT ... SELECT`, prints `(no rows)`, and `--json` prints an envelope with empty `data` and `meta` and `rows` set to `0`. `INSERT ... VALUES` with inline data is not supported, because ClickHouse reads the appended `FORMAT JSON` as part of the values; use `INSERT ... SELECT` instead.

### Exact values

The table and `--json` print the same values. A 64-bit or wider integer or a Decimal keeps every digit ClickHouse sent (see [large integers and Decimals](#large-integers-and-decimals-are-strings)). The TypeScript CLI needs Node.js 22 or later, or Bun, for this: on an older Node.js, a query that returns such a column fails with an error instead of printing rounded digits. In the table, strings print without quotes, and arrays, maps and tuples print as compact JSON:

```
u64max               │ d128                           │ arr_u64
─────────────────────┼────────────────────────────────┼─────────────────────────────
18446744073709551615 │ 12345678901234567890.123456789 │ ["18446744073709551615","1"]

(1 row)
```

## Examples

```sh
chkit query "SELECT count() FROM users"
```

```
count()
───────
42

(1 row)
```

Override the ObsessionDB service for a single query by service name or saved alias:

```sh
chkit query "SELECT count() FROM users" --service customer-b
```

Machine-readable JSON output:

```sh
chkit query "SELECT count() FROM users" --json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Query executed successfully |
| 1 | Missing SQL, no executor configured, or query failed |

## JSON output

`--json` prints the raw ClickHouse result envelope (the `JSON` format), not a chkit-specific wrapper:

```json
{
  "data": [
    { "count()": "42" }
  ],
  "meta": [
    { "name": "count()", "type": "UInt64" }
  ],
  "rows": 1,
  "statistics": {
    "elapsed": 0.000773,
    "rows_read": 1,
    "bytes_read": 1
  },
  "query_id": "6f1c0e8e-5d5a-4f0e-9c1b-2b8d7c3e9a41"
}
```

- `data` — the result rows.
- `meta` — column names and ClickHouse types.
- `rows` — the row **count** (a number), not the rows array.
- `statistics` — server-side timing and read counters.
- `query_id` — present when the executor reports it.

There is no `rowCount`, `command`, or `schemaVersion` field; the row count lives in `rows`.

### Large integers and Decimals are strings

ClickHouse writes 64-bit and wider integers and Decimals as bare JSON numbers, which many JSON parsers read as 64-bit floats: `18446744073709551615` becomes `18446744073709552000`, and a `Decimal128` loses digits. `chkit query` reads them without losing digits and prints them as strings of the digits ClickHouse sent, the same in the TypeScript CLI and chkit-py:

| ClickHouse type | JSON value |
|-----------------|------------|
| `UInt8`–`UInt32`, `Int8`–`Int32`, `Float32`, `Float64` | number |
| `UInt64`, `Int64`, `UInt128`, `Int128`, `UInt256`, `Int256` | string, e.g. `"18446744073709551615"` |
| `Decimal(P, S)` of any width | string, e.g. `"12345678901234567890.123456789"` |
| `JSON`, `Object`, `Dynamic` | every number inside is a string |

Every number in a column whose type contains one of these types is a string, also inside arrays, maps, tuples and `Nullable`: `Array(UInt64)` prints `["18446744073709551615","1"]`, and `Tuple(UInt8, UInt64)` prints both numbers as strings. `meta[].type` gives each column's type. Through an ObsessionDB service the console API returns every value as a string.

## Related commands

- [`chkit status`](/cli/status/) — show migration state
- [`chkit drift`](/cli/drift/) — compare snapshot to live ClickHouse
