---
"@chkit/clickhouse": patch
"chkit": patch
---

Identify chkit in ClickHouse requests by setting the HTTP `User-Agent` to `chkit/<version>` (e.g. `chkit/0.1.0-beta.21 clickhouse-js/1.17.0 (lv:nodejs/...; os:...)`), making it easy to filter chkit traffic in ClickHouse query logs.
