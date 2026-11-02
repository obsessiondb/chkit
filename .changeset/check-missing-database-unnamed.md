---
"chkit": patch
---

`chkit check` no longer prints `Database "undefined"` when the target database is missing and no database is configured (a plugin target without a `clickhouse` block); it prints `Database ""`, as `chkit status` and `chkit drift` do.
