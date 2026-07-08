---
"@chkit/plugin-backfill": patch
---

Fix `mv_replay` backfill of a from-scratch empty aggregate target. Chunk planning now sizes chunks against the materialized view's source table (the one it reads `FROM`) instead of the target, so bootstrapping an empty rollup no longer fails with "No partitions found for &lt;target&gt;". The empty-check still guards the source, and multi-view fan-in from different sources keeps its existing behaviour.
