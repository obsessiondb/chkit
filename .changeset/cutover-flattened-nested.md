---
"chkit": patch
---

`chkit generate --cutover` now cuts over a table with flattened `Nested` columns (ClickHouse 25.1 or newer) instead of failing at the mirror, and refuses one stored with `flatten_nested = 0` before it creates anything.
