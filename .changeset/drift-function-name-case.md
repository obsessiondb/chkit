---
"chkit": patch
"@chkit/clickhouse": patch
---

Drift canonicalizes SQL function names through the server's `system.functions` registry instead of lowercasing every call (#731). Spelling differences that ClickHouse itself normalizes (`FLOOR` stored as `floor`, the alias `CEILING` stored as `ceil`) no longer report drift, while case-sensitive and unknown names keep their written spelling instead of being lowercased into a different function.
