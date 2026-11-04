---
"chkit": patch
---

`chkit migrate --setting` rejects ClickHouse HTTP parameters such as `database`, `query_id` and `password` with a usage error before anything runs (#353).
