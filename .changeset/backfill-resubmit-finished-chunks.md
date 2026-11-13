---
"@chkit/plugin-obsessiondb": patch
---

`chkit plugin backfill submit --plan-id` no longer sends a chunk again when it finished in an earlier job, so a plan re-submitted more than once writes each chunk only once.
