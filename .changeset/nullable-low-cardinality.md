---
"@chkit/core": patch
---

Nullable LowCardinality columns render as `LowCardinality(Nullable(T))`, whether declared with `nullable: true`, `.nullable()`, `.optional()` or `t.nullable()`.
