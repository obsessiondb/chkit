---
"chkit": patch
---

`generate` with a rename now drops a skip index, constraint or projection before the column it reads, so `migrate` no longer fails on that `DROP COLUMN`.
