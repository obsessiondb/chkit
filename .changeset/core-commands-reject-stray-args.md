---
"chkit": patch
---

`generate`, `migrate`, `status`, `drift` and `check` reject an argument that is not a flag (`chkit migrate prod --apply`) with `Got unexpected extra argument(s) (prod)` and exit code 1, before any plugin hook runs, as chkit-py does; they used to ignore it and run.
