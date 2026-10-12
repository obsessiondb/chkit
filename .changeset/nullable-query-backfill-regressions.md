---
"chkit": patch
"@chkit/core": patch
"@chkit/clickhouse": patch
---

Fix equivalent nullable column types reporting drift or generating unnecessary migrations, preserve the final JSONEachRow query row when the response has no trailing newline, and stop successful `assert_backfill` guards from waiting for a nonexistent table (#274).
