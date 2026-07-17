---
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"@chkit/core": patch
"chkit": patch
---

Support index-only projections (`PROJECTION p INDEX (a, b) TYPE basic`) end to end. `ProjectionDefinition` is now a union of the existing `{ name, query }` SELECT form and a new `{ name, index, type }` index-only form, which renders without the wrapping parens that made the SELECT form invalid for it. `chkit pull` previously parsed only the SELECT form and dropped index-only projections on the floor, so a pulled schema silently recreated the table without them; they now round-trip through pull, generate, migrate, and drift.

Index expressions are normalized the way ClickHouse normalizes them — a single expression renders bare (`INDEX a`), several render as a tuple (`INDEX (a, b)`) — so `'(a)'` and `'a'` describe the same table and no longer read as drift.
