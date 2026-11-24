---
"@chkit/plugin-backfill": patch
"@chkit/plugin-obsessiondb": patch
---

A backfill chunk into a `Distributed` table is no longer marked done while its rows are still queued: chunk INSERTs default to `distributed_foreground_insert = 1` and `materialized_views_ignore_errors = 0`. The new `insertSettings` option adds settings to every chunk INSERT and can override those two defaults, with a warning naming the guarantee that is off.
