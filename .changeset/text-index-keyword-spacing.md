---
"chkit": patch
---

Text index SQL in generated migrations, snapshots and `chkit pull` output keeps the space between a keyword and `(` (`a OR (b)`, `NOT (x)`, `x IN (1, 2)`), as ClickHouse writes it, instead of `OR(`. Existing indexes and snapshots still compare equal, so no migration is planned.
