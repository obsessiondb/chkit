---
"@chkit/core": patch
---

`.nullable()`, `.optional()` and `t.nullable()` on a `t.lowCardinality(...)` type now render `LowCardinality(Nullable(T))` instead of throwing.
