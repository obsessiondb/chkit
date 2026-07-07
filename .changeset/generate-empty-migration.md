---
"chkit": patch
"@chkit/codegen": patch
---

Add `chkit generate --empty` to scaffold a blank manual migration. Unlike a normal `generate`, empty mode skips the schema diff, plugin pipeline, and table scoping entirely and writes a timestamped `.sql` stub with the standard migration header (`operation-count: 0`) plus a placeholder comment. The snapshot is left untouched, so an empty migration never absorbs pending schema drift. Use it for DDL that chkit does not model — backfills, `OPTIMIZE`, dictionary reloads, or one-off data fixes. The `--name` (default `manual`) and `--migration-id` flags apply; `migrate` picks the file up like any generated one. New `generateEmptyMigration` helper exported from `@chkit/codegen`.
