---
"@chkit/clickhouse": patch
"chkit": patch
---

Bump the default `request_timeout` on the internal `@clickhouse/client` from the library default (30s) to 2 minutes. Longer-running DDL and INSERTs (for example the ClickBench dataset load) were hitting a 30s socket timeout that killed the migrate in-flight; 2 minutes is a saner default for the kinds of statements chkit migrations issue. Stateless, session, and DDL-fallback clients all share the new default.
