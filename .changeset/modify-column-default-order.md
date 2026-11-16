---
"chkit": patch
---

`generate` now adds a column before a changed column's `MODIFY COLUMN` whose new DEFAULT, MATERIALIZED or ALIAS expression reads it, and drops a column only after the `MODIFY COLUMN` of a column whose old expression reads it, so `migrate` no longer fails partway (#745).
