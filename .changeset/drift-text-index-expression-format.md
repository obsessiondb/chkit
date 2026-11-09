---
"chkit": patch
---

`chkit drift` no longer reports `index_mismatch` on a text index right after `migrate` when ClickHouse stores its expression with added parentheses, such as `NOT a AND b` as `(NOT a) AND b`.
