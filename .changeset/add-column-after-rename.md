---
"chkit": patch
---

`generate` with a column rename now runs the `RENAME COLUMN` before an `ADD COLUMN` whose expression reads the new name, so `migrate` no longer fails on that `ADD COLUMN`.
