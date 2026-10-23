---
"chkit": patch
"@chkit/clickhouse": patch
---

Wait for a dictionary in `system.tables` on every replica after create or replace. `system.dictionaries` is each replica's in-memory loader and drops the dictionary while it reloads, so `migrate` could time out after `CREATE OR REPLACE DICTIONARY` had already landed in the catalog. On several replicas the wait holds until every replica stores the same non-nil `uuid`. ClickHouse redacts a SOURCE password to `[HIDDEN]` in `create_table_query`, so a password-only replace cannot be told apart from the previous definition; the UUID still changes, including for that replace.
