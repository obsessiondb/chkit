---
"chkit": patch
---

`chkit generate --cutover` now refuses a Nullable key column whose type has a comment or a quoted type name, such as `` `Nullable`(UInt64) ``.
