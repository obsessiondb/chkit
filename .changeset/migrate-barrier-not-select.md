---
"chkit": patch
---

`migrate --apply` refuses, before it runs anything, a pending statement marked `mode=barrier` that is not a `SELECT` (code `barrier_not_select`); such a statement used to run through the insert barrier read with no replica wait (#634).
