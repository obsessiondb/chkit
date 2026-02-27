---
"chkit": patch
"@chkit/clickhouse": patch
---

Fix silent exit with no error output when ClickHouse is unreachable. The CLI now displays clear error messages for connection failures (connection refused, host not found, timeout, etc.) including the configured ClickHouse URL. Added fallback error formatting for any errors with empty messages.
