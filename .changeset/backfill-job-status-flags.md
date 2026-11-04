---
"@chkit/plugin-obsessiondb": patch
---

`chkit plugin backfill status --job-id` and `cancel --job-id` now work, because `chkit plugin <name> <command>` accepts flags that other plugins add (#303). The ObsessionDB job commands print the job in text mode, where they printed nothing, and return the standard `--json` envelope instead of the raw console API object.
