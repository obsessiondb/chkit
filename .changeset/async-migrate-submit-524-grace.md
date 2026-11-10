---
"chkit": patch
---

`migrate --apply` no longer journals a completed async data load as failed when the submit request fails indeterminately. A proxy or network can cut the submit request (e.g. HTTP 524) although the server received the query and kept running it; if a poll then read the query as `unknown` inside the `system.query_log` flush gap, chkit recorded the attempt as failed even though the load later completed, and a re-run loaded the rows a second time (#657). A definitive server rejection (a ClickHouse exception code, an authentication failure) still fails the attempt right away, but an indeterminate submit error now gets a bounded poll grace so the query log can catch up; if no server trace appears, the attempt stays `started` and the error asks to re-run `chkit migrate --apply` to re-attach via the deterministic `query_id`.
