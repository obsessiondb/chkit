---
"chkit": patch
"@chkit/core": patch
"@chkit/plugin-pull": patch
---

`pull` then `generate` plans nothing on a database chkit migrated (#466). `pull` leaves out chkit's migration journal (`_chkit_migrations` or `CHKIT_JOURNAL_TABLE`) and the settings the server fills in: a MergeTree setting at its `system.merge_tree_settings` value (such as `index_granularity = 8192`) and ObsessionDB's `storage_policy = 's3'` on `Shared` tables. `generate` compares a literal default with the expression pull reads back by the SQL it renders (`7` and `{ expression: '7' }`), settings by their rendered value (`4096` and `'4096'`), a dictionary `lifetime` in the form ClickHouse stores (`300` and `MIN 0 MAX 300`), and dictionaries whatever order their keys are written in.
