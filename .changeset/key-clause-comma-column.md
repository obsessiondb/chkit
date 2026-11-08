---
"chkit": patch
---

`generate` now plans the table recreate when a key changes between separate columns (`a`, `b`) and one column whose name contains a comma (`a, b`).
