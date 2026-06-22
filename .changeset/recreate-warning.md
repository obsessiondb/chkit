---
"chkit": patch
---

`chkit migrate` now flags a destructive table **recreate** (a `DROP TABLE` + `CREATE TABLE` caused by changing `engine`, `orderBy`, `primaryKey`, `partitionBy`, or `uniqueKey`) with a distinct `table_recreate_data_loss` warning instead of the generic `drop_table_data_loss`. The warning spells out that all rows are permanently deleted and the table is recreated empty, and recommends migrating via a temporary table to preserve data. Documented in the migrate and schema DSL reference pages.
