---
"@chkit/plugin-backfill": patch
---

`chkit plugin backfill run`, `resume` and `cancel` now hold a lock on the plan, so a second one of the same plan fails at once instead of writing its checkpoint or submitting its chunks a second time; Ctrl-C releases the lock cleanly, and each checkpoint write is synced to disk.
