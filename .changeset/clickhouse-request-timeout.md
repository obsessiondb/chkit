---
"@chkit/clickhouse": patch
"chkit": patch
---

Disable the `@clickhouse/client` `request_timeout` for the internal chkit clients (was the library default of 30s). The underlying timer is a socket inactivity timeout, and ClickHouse stays silent on the response stream during long INSERTs and DDL — so any finite value eventually kills legitimate work mid-flight (the ClickBench dataset load tripped at 30s). Setting `request_timeout: 0` leaves TCP keepalive to detect dead connections instead. Applies to the stateless, session, and DDL-fallback clients.
