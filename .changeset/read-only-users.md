---
"chkit": patch
---

chkit works with a read-only ClickHouse user (`readonly = 1` or `2`, granted `SELECT`) for `query`, `status`, `check`, `drift`, `pull` and `migrate` without `--apply` (#402).

Upgrade: a journal table created before per-operation tracking needs a one-time `ALTER` by a user allowed to run it; until then read-only users get an error.
