---
"chkit": patch
---

`generate` now renames a column before a new column whose DEFAULT, MATERIALIZED or ALIAS expression reads the new name, so `migrate` no longer fails with an unknown identifier (#746).
