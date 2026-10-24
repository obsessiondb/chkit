---
"chkit": patch
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/codegen": patch
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

Add a zero-downtime cutover for structural table changes (#202). `chkit generate --cutover db.table=<unique key>` replaces the DROP TABLE + CREATE TABLE of an engine, ORDER BY, PRIMARY KEY or PARTITION BY change with a migration that mirrors new inserts into a shadow table, waits out the INSERTs that started before the mirror, snapshots and copies the existing rows (skipping keys the shadow already holds), verifies the copy per key, and swaps the tables with a guarded `EXCHANGE TABLES` (a new `exchange_tables` operation, risk `caution`) while writers keep inserting, then attaches the rows of INSERTs that straddled the swap. `--cutover-copy backfill` leaves the copy to `chkit plugin backfill plan|submit --cutover db.table`; `--cutover-old keep|drop` keeps the old table as `<table>_previous` (recorded in the snapshot as retained, dropped later with `generate --drop-retained`) or drops it.

`migrate` now runs a synchronous statement's `-- before-retry:` SQL before it retries the statement after a failed or interrupted attempt (it was ignored outside `mode=async`), supports `mode=barrier` statements that wait for the INSERTs running when the step started, and waits after an `EXCHANGE TABLES` until every replica of a multi-replica target agrees on both tables. `chkit plugin backfill plan` reads through a session-less connection, so chunk refinement no longer fails with "Session is locked by a concurrent client".
