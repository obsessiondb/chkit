---
"chkit": patch
"@chkit/clickhouse": patch
"@chkit/plugin-obsessiondb": patch
---

`chkit migrate --setting <name=value>` sends ClickHouse query settings with every statement a migration runs (#321): synchronous statements, `mode=async` submissions, `mode=barrier` reads and `-- before-retry:` SQL. `chkit migrate --apply --allow-destructive --setting max_table_size_to_drop=0` drops a table larger than the server's `max_table_size_to_drop` (50 GB by default), which a managed service gives no other way to lift. The flag is optional, repeatable, and also takes a comma-separated list; without it no settings are sent, and chkit's journal and polling queries never get them. `ClickHouseExecutor.command()` and `submit()` take optional settings, which the ObsessionDB remote executor forwards to the console API.
