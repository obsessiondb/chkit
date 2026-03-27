---
"@chkit/plugin-codegen": patch
"@chkit/core": patch
"chkit": patch
---

Add `emitMigrations` option to the codegen plugin. When enabled, generates a self-contained TypeScript module with all migration SQL inlined and a `runMigrations()` function for environments without filesystem access (e.g., Cloudflare Workers). Also extracts `splitSqlStatements` and `extractExecutableStatements` into `@chkit/core` as shared utilities.
