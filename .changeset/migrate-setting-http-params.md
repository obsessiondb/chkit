---
"chkit": patch
"@chkit/clickhouse": patch
---

`chkit migrate --setting` rejects ClickHouse HTTP parameters with a usage error before anything runs (#353): `query`, `database`, `query_id`, `session_id`, `session_check`, `session_timeout`, `user` and `password`. They are not query settings: `database` sent unqualified statements to another database while the journal recorded them as applied, and `password` ended up in the server's logs. `ClickHouseExecutor.submit()` no longer sends a second `query_id` when its settings carry one.
