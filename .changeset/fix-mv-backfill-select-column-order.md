---
"@chkit/plugin-backfill": patch
---

Fix materialized view backfill INSERT by rewriting SELECT column order to match target table. ClickHouse's positional column mapping requires SELECT output columns to be in the same order as the INSERT target columns, not matched by name.
