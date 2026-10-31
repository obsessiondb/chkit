---
"chkit": patch
"@chkit/clickhouse": patch
---

`chkit drift` and `chkit check` compare the query of each managed view and materialized view, and a materialized view's `TO` target, with the live ones (#382). Before, they only checked that the object existed with the right kind, so a view or materialized view recreated on the server with another query passed `check --strict`. A changed query reports `query_mismatch` and a changed target `target_mismatch` (also for a materialized view recreated with an inner table), with the compared values in `expected` and `actual`. Both queries go through ClickHouse's formatter, and the database qualifier ClickHouse adds to unqualified table names and to the dictionary name in `dictGet('users', …)` is dropped for the connection's database, so an unchanged view reads clean. A query the server can't format is not compared, nor is one in which ClickHouse hid a secret as `'[HIDDEN]'` (a table function's password), which would never match: drift does not send the schema's query to the formatter then, so the secret is neither printed nor logged in `system.query_log`.

The drift command also formats expressions and queries one after the other: sent at once on the CLI's single ClickHouse session, they could fail with "Session is locked by a concurrent client", and drift then fell back to plain text matching for that run.
