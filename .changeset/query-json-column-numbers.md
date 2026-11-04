---
"chkit": patch
---

In `JSON`, `Object` and `Dynamic` columns, `chkit query` returns a number as a string only when a double cannot hold it exactly; other numbers stay numbers (#438).
