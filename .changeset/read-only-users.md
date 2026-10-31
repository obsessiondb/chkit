---
"chkit": patch
"@chkit/clickhouse": patch
---

chkit works with a read-only ClickHouse user (`readonly = 1` or `readonly = 2`, granted `SELECT`) for `query`, `status`, `check`, `drift`, `pull` and `migrate` without `--apply` (#402). Reads send no settings: `@chkit/clickhouse` sent `async_insert = 0` and `send_progress_in_http_headers = 1` with every request, which a `readonly = 1` user cannot change (`Cannot modify 'async_insert' setting in readonly mode`). They now go with `command` and `insert` only; reads keep `wait_end_of_query = 1`, an HTTP parameter every user may send. Reading the journal no longer writes: a missing `_chkit_migrations` table reads as no applied migrations and is created by the first journal write of `migrate --apply`, and the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` upgrade runs only for a journal that lacks the per-operation columns. A `readonly = 1` user reads the journal without `select_sequential_consistency`. `migrate --apply` with a read-only user fails with the ClickHouse error, as before.
