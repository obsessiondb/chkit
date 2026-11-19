---
"chkit": patch
---

`generate` no longer treats keywords such as `end`, `is`, `from` or `null`, or the alias name in `x AS alias`, as reads of a column with that name, so `migrate` no longer fails on a `DROP COLUMN` ordered too early for such tables.
