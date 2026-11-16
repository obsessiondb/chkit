---
"chkit": patch
---

`generate` with a column rename now runs the `RENAME COLUMN` before a `MODIFY COLUMN` whose new expression reads the new name, so `migrate` no longer fails on that `MODIFY COLUMN`.
