---
"chkit": patch
---

`chkit drift` and `chkit check` now report `engine_mismatch` when an engine argument differs only in case, such as `CollapsingMergeTree(Sign)` against a live `CollapsingMergeTree(sign)`, because column names and strings in engine arguments are case-sensitive.
