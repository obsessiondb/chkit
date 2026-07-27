---
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"chkit": patch
---

Fix two related pull/drift bugs around tables whose `ORDER BY` is declared alongside a projection or a derived primary key.

`chkit pull` parsed table-level clauses (`ENGINE`, `ORDER BY`, `PRIMARY KEY`, `PARTITION BY`, `TTL`, `SETTINGS`) by matching the first keyword anywhere in `SHOW CREATE TABLE`. A projection whose `SELECT` body contains `ORDER BY` — or a column-level `TTL` — sits in the column list before those clauses, so the parser matched the inner keyword and swallowed the engine into `orderBy`/`primaryKey`, producing an invalid pulled schema (#190). Table-level clauses are now parsed only from the portion after the column list.

`chkit drift` always reported `primary_key_mismatch` for any table whose `PRIMARY KEY` is derived from `ORDER BY`. ClickHouse omits the derived key from `SHOW CREATE TABLE`, but the schema carries it, so the two never matched. Drift now applies the same derivation to the live side, so a derived primary key reads clean while a genuine primary-key difference is still reported (#194).
