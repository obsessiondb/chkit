---
"chkit": patch
---

Text index SQL in generated migrations, snapshots and `chkit pull` output keeps array subscripts tight (`lower(s)[1]`, `m['k']`), as ClickHouse writes them, instead of `lower(s) [1]`. Existing indexes and snapshots still compare equal, so no migration is planned.
