---
"@chkit/core": patch
---

`chkit generate --cutover` now cuts over a table with a flattened `Nested` column instead of failing at the mirror, and refuses one stored with `flatten_nested = 0` before it creates anything.
