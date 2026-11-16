---
"chkit": patch
---

`chkit generate --cutover` now refuses a key column typed `LowCardinality(Nullable(T))`, as it already did for `Nullable(T)`.
