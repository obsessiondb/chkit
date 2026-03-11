---
"@chkit/core": patch
---

Validate that `set`, `tokenbf_v1`, and `ngrambf_v1` skip index types require `typeArgs` (ClickHouse 26+ compliance). Type-level validation enforces this at compile time; runtime validation provides a safety net.
