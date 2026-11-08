---
"chkit": patch
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"@chkit/plugin-obsessiondb": patch
---

`pull` then `generate` plans nothing, and `drift` reports nothing, on a database chkit migrated (#466).

- `pull` keeps every setting the server stores, including `index_granularity`, and leaves out chkit's migration journal (`_chkit_migrations` or `CHKIT_JOURNAL_TABLE`) and the hidden `auto_minmax_index_*` skip indexes ClickHouse creates for the `add_minmax_index_for_*` settings.
- A MergeTree table without `index_granularity` is treated as `index_granularity: 8192`, the value ClickHouse stores, so new `CREATE TABLE` statements write `SETTINGS index_granularity = 8192`. Existing projects plan nothing for it.
- Setting values compare by value (`4096` and `"4096"`, `2.0` and `2.`), and a literal column default compares by value with the expression pull reads back (`7` and `{ expression: '7' }`, `"it's"` and `'it\'s'`, newlines and tabs as ClickHouse escapes them).
- A change to a setting ClickHouse cannot alter on an existing table (`index_granularity`, `index_granularity_bytes`, the `add_minmax_index_for_*` settings and others) plans `DROP TABLE` and `CREATE TABLE`, like an `ORDER BY` change, instead of an `ALTER` the server rejects. `--cutover` refuses such a change and says why.
- The ObsessionDB plugin leaves `storage_policy = 's3'`, which ObsessionDB writes into every `Shared` table, out of the schema and the snapshot on every target. A new `onSnapshotLoaded` plugin hook applies a plugin's schema rewrite to the previous snapshot, so a snapshot written before the rewrite plans no `RESET SETTING`.
- A dictionary `lifetime` compares in the form ClickHouse stores (`300` and `MIN 0 MAX 300`), and dictionaries compare whatever order their keys are written in.
