---
"@chkit/core": patch
"chkit": patch
---

Generate idempotent `RENAME COLUMN` / `RENAME TABLE` statements using `IF EXISTS`. Renames are the one non-idempotent generated DDL: replaying `RENAME COLUMN a TO b` after it already ran fails with "unknown identifier". With `IF EXISTS`, a replay after a partial migration failure (or alongside per-statement resume) is a safe no-op instead of bricking the migration. Applies to both auto-detected rename suggestions and explicit `--rename-column` / `--rename-table` / `renamedFrom` renames.
