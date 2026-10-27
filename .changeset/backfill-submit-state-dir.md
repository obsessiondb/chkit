---
"@chkit/plugin-obsessiondb": patch
---

The ObsessionDB managed `chkit plugin backfill submit` now applies the backfill plugin's options, as the local `plan` does (#309). It ignored `backfill({ stateDir })`, so it saved the plan and the submission marker in the default `<metaDir>/backfill/` while `chkit check` read the configured `stateDir`. `submit` now saves both in the configured `stateDir`, and the ObsessionDB check reads the markers from it. The other planning options set in `backfill({...})` (such as `maxChunkBytes`, `maxRetriesPerChunk`, `requireIdempotencyToken`, `chunkHours`, `timeColumn`) now apply to `submit` too; flags still override them.
