---
"chkit": patch
"@chkit/clickhouse": patch
---

`chkit query` no longer rounds 64-bit and wider integers and Decimals, in the table or in `--json` (#381).

Breaking: `--json` prints these values as strings instead of numbers.

Breaking: `chkit` and `@chkit/clickhouse` now require Node.js 22 or later (or Bun).
