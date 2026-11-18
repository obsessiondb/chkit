---
"@chkit/plugin-backfill": patch
---

`chkit plugin backfill run` and `resume` now hold a lock on the plan, so a second run or resume of the same plan fails at once instead of submitting its chunks a second time, and each checkpoint write is synced to disk.
