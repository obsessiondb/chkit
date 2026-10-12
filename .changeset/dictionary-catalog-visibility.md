---
"chkit": patch
"@chkit/clickhouse": patch
---

Wait for a dictionary in `system.tables` on every replica after create or replace. `system.dictionaries` is each replica's in-memory loader and drops the dictionary while it reloads, so `migrate` could time out after `CREATE OR REPLACE DICTIONARY` had already landed in the catalog. On several replicas the wait holds until every replica stores the same definition.
