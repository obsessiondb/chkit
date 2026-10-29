---
"chkit": patch
"@chkit/clickhouse": patch
"@chkit/plugin-obsessiondb": patch
---

`chkit migrate --setting <name=value>` sends ClickHouse query settings with each migration statement (#321), so `chkit migrate --apply --allow-destructive --setting max_table_size_to_drop=0` drops a table larger than the server's `max_table_size_to_drop` (50 GB by default), which a managed service gives no other way to lift. The flag is repeatable and also takes a comma-separated list. `ClickHouseExecutor.command()` takes optional per-statement settings, which the ObsessionDB remote executor forwards to the console API.
