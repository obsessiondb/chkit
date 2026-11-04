---
"chkit": patch
"@chkit/clickhouse": patch
"@chkit/plugin-obsessiondb": patch
---

New `chkit migrate --setting <name=value>` sends ClickHouse query settings with every statement a migration runs, for example `--setting max_table_size_to_drop=0` to drop a table larger than the server's drop limit (#321).
