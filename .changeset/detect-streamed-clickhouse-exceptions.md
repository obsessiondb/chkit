---
"@chkit/clickhouse": patch
"chkit": patch
---

Detect ClickHouse exceptions that arrive in the `x-clickhouse-exception-code` response header on an HTTP 200 response. When `send_progress_in_http_headers=1` is set (chkit's default for long-running migrations), ClickHouse commits to a 200 status before the query completes; if the query then errors, the exception is reported via response headers rather than as an HTTP error code. `@clickhouse/client` does not surface this as a thrown error, so previously `chkit migrate` could record a failed INSERT migration as applied while the data never landed.

`@chkit/clickhouse` now inspects `result.response_headers` after every `command`/`query`/`queryJson`/`insert` call and throws a new `ClickHouseStreamedException` (with `code`, `exceptionTag`, and `query_id`) when a non-zero exception code is present. Migrations that fail this way now exit with a non-zero status and remain pending so the operator can fix the underlying issue and re-apply.
