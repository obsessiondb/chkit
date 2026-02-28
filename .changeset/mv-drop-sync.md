---
"@chkit/core": patch
---

Fix materialized view drop operations on ClickHouse Cloud by using `DROP TABLE ... SYNC` instead of `DROP VIEW IF EXISTS`. This ensures metadata removal is fully propagated before subsequent column drop operations execute, preventing "column is referenced by materialized view" errors.
