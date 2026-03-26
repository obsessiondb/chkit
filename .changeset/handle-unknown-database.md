---
"chkit": patch
"@chkit/clickhouse": patch
---

Gracefully handle ClickHouse error 81 (UNKNOWN_DATABASE) when the configured database does not exist yet. Commands `status`, `drift`, `check`, and `migrate` no longer crash with a raw stack trace; instead they show a warning and continue with normal output.
