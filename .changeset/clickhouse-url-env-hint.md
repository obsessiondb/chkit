---
"@chkit/clickhouse": patch
---

Connection-refused errors now hint at the missing `CLICKHOUSE_URL` env var when chkit fell back to the default `http://localhost:8123` endpoint. Previously, first-time users who forgot to set the env var saw a bare "connection refused" message with no clue that the env var was the fix.
