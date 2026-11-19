---
"chkit": patch
"@chkit/clickhouse": patch
---

An async `chkit migrate --apply` statement now runs with `async_insert = 0`, as sync statements already did, so an `INSERT … VALUES` is no longer recorded as applied while its rows are still in the asynchronous-insert buffer. `migrate --setting async_insert=1` is refused before anything runs.
