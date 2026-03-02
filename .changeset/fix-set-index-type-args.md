---
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
---

Fix parameterized skip index type rendering. ClickHouse requires `set` indexes to have a size argument (e.g., `set(0)` for unlimited). Add optional `typeArgs` field to `SkipIndexDefinition` to support parameterized index types (`set`, `bloom_filter`, `tokenbf_v1`, `ngrambf_v1`) and parse type arguments from introspected schemas.
