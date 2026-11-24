---
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

A backfill chunk into a `Distributed` table is no longer marked done while its rows are still queued: chunk INSERTs default to `distributed_foreground_insert = 1` and `materialized_views_ignore_errors = 0`, and always run with `log_queries_probability = 1`. The new `insertSettings` plugin option adds settings to every chunk INSERT (`run`, `resume` and managed `submit`) and can override the two defaults with a warning, while settings chkit relies on, such as `async_insert` or the dedup token, are refused.
