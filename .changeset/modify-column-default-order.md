---
"chkit": patch
---

`generate` now adds a column before a changed column's `MODIFY COLUMN` whose new DEFAULT, MATERIALIZED or ALIAS expression reads it, so `migrate` no longer fails with an unknown identifier (#745).
