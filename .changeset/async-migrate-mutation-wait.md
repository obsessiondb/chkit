---
"chkit": patch
---

`chkit migrate --apply` records an async `ALTER ... UPDATE/DELETE`, `OPTIMIZE`, `TRUNCATE` or `ON CLUSTER` statement as completed only once its mutation or task has finished on every replica and host, instead of as soon as it was queued; a mutation that fails now stops the run with `async_outcome_unknown`.
