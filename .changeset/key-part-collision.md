---
"chkit": patch
---

`chkit generate` plans a table recreate, and `chkit drift` reports `order_by_mismatch` / `primary_key_mismatch`, when a key moves between columns `a` and `b` and one column named `a, b` (or between `a b` and `ab`); before, both read the key as unchanged.
