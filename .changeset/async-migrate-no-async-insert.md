---
"chkit": patch
"@chkit/clickhouse": patch
---

Every `chkit migrate --apply` statement, async ones included, now runs with `async_insert = 0` and `wait_for_async_insert = 1` by default, sent after any `--setting profile`, so an `INSERT … VALUES` is no longer recorded as applied while its rows are still buffered. `--setting async_insert` or `--setting wait_for_async_insert` overrides these defaults and prints a warning naming the guarantee that is off.
