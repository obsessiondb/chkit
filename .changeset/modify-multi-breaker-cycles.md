---
"chkit": patch
---

`generate` runs a `MODIFY COLUMN` that would break a temporary default cycle before the `MODIFY COLUMN` that would close it, when more than one could break it, so `migrate` no longer fails with `Cyclic alias detected` for those changes.
