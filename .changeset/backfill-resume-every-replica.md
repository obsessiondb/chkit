---
"@chkit/plugin-backfill": patch
---

`backfill resume` checks chunk status on every replica of a multi-replica target, so it no longer resubmits a chunk that is running or finished on another replica (#289).
