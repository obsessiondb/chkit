---
"chkit": patch
---

`chkit migrate --apply` now records an async statement other than a SELECT or an INSERT as completed only once the server reports its work done: it is sent with `mutations_sync = 2`, `alter_sync = 2`, `distributed_ddl_task_timeout = -1` and `distributed_ddl_output_mode = 'throw'`, so an `ALTER ... UPDATE/DELETE` waits for its mutation on every replica and an `ON CLUSTER` statement for every host, and a mutation that fails stops the run with `async_outcome_unknown`.
