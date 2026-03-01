---
"@chkit/plugin-backfill": patch
---

Fix option merging to prevent undefined values from overwriting base defaults, which caused `RangeError: Invalid Date` when using partial backfill config objects. Add validation to catch undefined/NaN numeric fields earlier with clearer error messages.
