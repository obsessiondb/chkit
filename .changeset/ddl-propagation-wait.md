---
"chkit": patch
"@chkit/clickhouse": patch
---

Fix: Migrations no longer fail with "table not found" errors on distributed ClickHouse setups when creating materialized views that reference tables created in the same migration. The migrate command now polls `system.tables`/`system.columns` after each DDL statement to confirm propagation before proceeding.
