---
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"@chkit/core": patch
"chkit": patch
---

Support index-only projections (`PROJECTION p INDEX (a, b) TYPE basic`) end to end. `ProjectionDefinition` is now a union of the existing `{ name, query }` SELECT form and a new `{ name, index, type }` index-only form, which renders without the wrapping parens that made the SELECT form invalid for it. `chkit pull` previously parsed only the SELECT form and dropped index-only projections on the floor, so a pulled schema silently recreated the table without them; they now round-trip through pull, generate, migrate, and drift.

Index expressions are normalized to the exact form ClickHouse stores — a single expression bare (`INDEX a`), several as a tuple (`INDEX (a, b)`), redundant parens peeled at every level, and a space after each argument separator — so `'(a)'` and `'a'`, or `'concat(x,y)'` and `'concat(x, y)'`, describe the same table and no longer read as drift.

Two new validation errors guard the new form: `projection_ambiguous_kind` when an entry sets both `query` and `index` (which would otherwise silently discard the SELECT body), and `projection_empty_index` when the index expression is empty (which would otherwise emit invalid DDL).
