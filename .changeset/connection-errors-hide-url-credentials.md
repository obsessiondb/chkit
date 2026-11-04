---
"@chkit/clickhouse": patch
"chkit": patch
---

Connection errors and `CHKIT_DEBUG` logs no longer print credentials embedded in `clickhouse.url`, and such a URL no longer triggers `@clickhouse/client` override warnings on every run.
