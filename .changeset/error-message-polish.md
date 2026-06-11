---
"chkit": patch
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-obsessiondb": patch
---

Polish error messages and a few noisy outputs:

- A table defined with `orderBy` but no `primaryKey` no longer crashes with a raw `TypeError`; the primary key defaults to the order-by columns, matching ClickHouse.
- Built-in command errors (e.g. a rejected migration) surface their own clean message instead of being wrapped in `Plugin "core" failed in ...`.
- `chkit query` syntax errors no longer leak the injected `FORMAT JSON` clause the user never typed, and the "Expected one of" token dump is capped.
- Connection errors whose reason is only in the message (no `.code`) — e.g. a typo'd host — are now recognized and cleaned instead of leaking the raw client string.
- The post-apply message names the resolved journal table (respecting `CHKIT_JOURNAL_TABLE`) instead of a hardcoded `_chkit_migrations`.
- The ObsessionDB "authenticated but no service selected" reminder is suppressed when a direct `clickhouse` target is configured (it was layered in from a global login, not chosen for the project).
