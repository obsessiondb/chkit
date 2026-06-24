---
"chkit": patch
---

Clearer errors when things go wrong:

- A rejected migration now reports the migration file, the failed statement's position (e.g. "statement 2 of 3"), and a SQL preview, alongside the ClickHouse message — instead of a bare exception with no context.
- A syntax error in `clickhouse.config.ts` now prints the actual build diagnostics (each underlying error), instead of only the "N errors building config.ts" summary.
- Documented the column `codec` API (general/preprocessor/raw codecs, chains, and the codec-chain validation rules) in the schema DSL reference.
