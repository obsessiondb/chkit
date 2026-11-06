---
"chkit": patch
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-codegen": patch
---

Sort schema names by Unicode code point in the TypeScript implementation, matching chkit-py (#489). `localeCompare` consults the host's ICU data and ordered `_`, digits and case differently, so migrations, rename suggestions, canonical snapshots and drift output could come out in a different order than the Python implementation. `compareCodePoints` in `@chkit/core` now defines the shared order, and the planner, canonicalizer, drift output, table scope, ClickHouse introspection, codegen and generate pipeline use it.
