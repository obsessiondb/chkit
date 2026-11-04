---
"@chkit/plugin-obsessiondb": patch
---

ObsessionDB `chkit plugin backfill submit` now applies the `backfill({...})` options such as `stateDir` and `maxChunkBytes`, so `chkit check` finds its submissions in a custom `stateDir` (#309).
