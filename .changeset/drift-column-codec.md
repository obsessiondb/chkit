---
"chkit": patch
---

`chkit drift` and `chkit check` now report a column codec added, removed or changed on the server as `changed_column`, treating equivalent spellings such as `ZSTD` and `ZSTD(1)` as equal.
