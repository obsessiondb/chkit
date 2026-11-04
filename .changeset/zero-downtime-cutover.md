---
"chkit": patch
---

Add zero-downtime cutovers for structural table changes (#202):

- `chkit generate --cutover db.table=<unique key>` turns an engine, ORDER BY, PRIMARY KEY or PARTITION BY change into a migration that copies rows into a shadow table and swaps it in while writers keep inserting, instead of DROP and CREATE.
- `--cutover-copy backfill` leaves the copy to `chkit plugin backfill plan|submit --cutover`, and `--cutover-old keep|drop` keeps the old table as `<table>_previous` (remove it later with `generate --drop-retained`) or drops it.
- The cutover refuses changes it cannot carry over safely, such as a TTL, a rename or a Replicated table without `clickhouse.cluster`, and `migrate` stops before a swap while async inserts with `wait_for_async_insert = 0` reach the table.
- `migrate` now also runs `-- before-retry:` SQL for synchronous statements and supports `mode=barrier` statements.
- `chkit plugin backfill plan` no longer fails with "Session is locked by a concurrent client".
