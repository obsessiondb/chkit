---
"chkit": patch
---

`generate` now also adds a dotted column such as `n.x` before a new column whose expression reads it without backquotes, so `migrate` no longer fails with an unknown identifier (#748).
