---
"@chkit/plugin-backfill": patch
---

`chkit plugin backfill plan` works on ClickHouse 24.9 and older: it now turns parallel replicas off with `allow_experimental_parallel_reading_from_replicas`, which every version accepts, instead of `enable_parallel_replicas`, which servers before 24.10 reject.
