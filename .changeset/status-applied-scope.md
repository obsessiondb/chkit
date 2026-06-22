---
"chkit": patch
---

`status` now reports `Applied` scoped to migrations present in your project's migrations directory, rather than a global count from the journal table. On a shared ObsessionDB journal this previously counted other tenants' rows and could show `Applied` greater than `Total`.
