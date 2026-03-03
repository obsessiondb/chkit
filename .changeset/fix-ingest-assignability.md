---
"@chkit/plugin-codegen": patch
---

Generate row types as type aliases instead of interfaces to satisfy TypeScript's Record<string, unknown> assignability requirement. Fixes TypeScript error TS2322 when passing typed row arrays to ingest functions.
