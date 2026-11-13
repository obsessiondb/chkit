---
"chkit": patch
---

`generate` now adds a column before a new column whose DEFAULT, MATERIALIZED or ALIAS expression reads it, so `migrate` no longer fails with an unknown identifier (#681).
