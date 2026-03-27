---
"@chkit/plugin-codegen": patch
"@chkit/core": patch
"chkit": patch
---

Generated migration modules now import `extractExecutableStatements` from `@chkit/core/utils` instead of inlining the sql-splitter source. Adds a `./utils` sub-path export to `@chkit/core`.
