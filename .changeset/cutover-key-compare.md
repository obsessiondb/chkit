---
"chkit": patch
---

`chkit generate --cutover` compares sorting and primary keys the way the planner does: a change from a column named `a,b` to columns `a`, `b` is cut over instead of refused as "only the engine arguments change", and a key that is only respelled no longer counts as a layout change.
