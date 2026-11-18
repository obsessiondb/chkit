---
"chkit": patch
---

`drift` and `check` no longer report `changed_column` for a DEFAULT, MATERIALIZED or ALIAS expression that ClickHouse stores formatted differently, such as `id * 2 + 1` stored as `(id * 2) + 1` (#752).
