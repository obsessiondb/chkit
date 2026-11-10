---
"chkit": patch
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-codegen": patch
"@chkit/plugin-obsessiondb": patch
"@chkit/plugin-pull": patch
---

Names now sort by Unicode code point, as in chkit-py, so `generate`, `drift`, snapshots and codegen use the same order in both (#489). After upgrading, run `chkit codegen` once (`codegen --check` and `check` report the reordered output as stale), and check imports where two tables map to the same type name, since which one gets the `_2` suffix can change.
