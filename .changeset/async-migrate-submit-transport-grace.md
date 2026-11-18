---
"chkit": patch
"@chkit/plugin-obsessiondb": patch
---

`migrate --apply` no longer journals an async data load as failed when the submit request fails with a transport error (gateway 524, timeout, connection reset) before any poll saw the query running (#671). The server may be running the query unobserved, so an indeterminate submit error now gets the same bounded poll grace as one seen after the query was running; if no trace appears, the attempt stays `started` for a re-run to attach to. A definitive server rejection still fails the attempt at once in both executors: a rejection carries ClickHouse's exception code, relayed by the direct client in its error message and kept from the server's error text by the ObsessionDB console executor, while relayed network codes (209, 210) and code 216 (a query with the same id still running) do not count as rejections.
