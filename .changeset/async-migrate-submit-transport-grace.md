---
"chkit": patch
"@chkit/plugin-obsessiondb": patch
---

`migrate --apply` no longer journals an async data load as failed when the submit request fails with a transport error (gateway 524, timeout, connection reset) before any poll saw the query running (#671). The server may be running the query unobserved, so an indeterminate submit error now gets the same bounded poll grace as one seen after the query was running; if no trace appears, the attempt stays `started` and a re-run re-attaches via the deterministic `query_id`. A definitive server rejection still fails the attempt at once in both executors: the direct client carries ClickHouse's exception code, and the ObsessionDB console executor now keeps the code from the server's error text instead of dropping it.
