---
"chkit": patch
---

`chkit drift` and `chkit check` no longer report `engine_mismatch` for a `Null` table, or for an engine argument quoted in the schema that the server stores without quotes, such as ``ReplacingMergeTree(`Ver`)``.
