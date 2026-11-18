---
"chkit": patch
---

When `chkit migrate` times out waiting for a column change to apply, its next request, such as releasing the migrate lock, no longer fails with "Session is locked by a concurrent client".
