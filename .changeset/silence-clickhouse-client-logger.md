---
"@chkit/clickhouse": minor
---

Silence the built-in @clickhouse/client logger so a wrong password (or any connection error) no
longer leaks the raw ClickHouse server remediation blurb to stderr. chkit emits its own clean
one-line message and now sets the client log level to OFF explicitly, independent of the resolved
@clickhouse/client version (the upstream default changed from OFF to WARN in 1.18). Also raises
the @clickhouse/client dependency floor to ^1.18.0 so the shipped behavior matches what consumers
resolve.
