---
"chkit": patch
---

`chkit migrate` no longer submits an async statement again behind a load balancer over independent servers: without `clickhouse.cluster`, a prepared attempt in a journal that is not replicated now stops with `async_outcome_unknown` instead of being treated as never sent.
