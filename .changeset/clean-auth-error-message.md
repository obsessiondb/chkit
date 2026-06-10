---
"@chkit/clickhouse": patch
"chkit": patch
---

Replace the leaked ClickHouse server blurb on an authentication failure with a single clear line. A wrong `CLICKHOUSE_PASSWORD` previously dumped ~8 lines of ClickHouse Cloud password-reset instructions and `/etc/clickhouse-server/users.d/` filesystem paths that read as an internal error leak. chkit now detects auth failures (ClickHouse error codes 194/516, `REQUIRED_PASSWORD`/`AUTHENTICATION_FAILED`, or an "Authentication failed" message) and reports: `Authentication failed for user "<user>" at <url>. Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD.`
