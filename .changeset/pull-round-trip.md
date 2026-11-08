---
"chkit": patch
"@chkit/core": patch
"@chkit/clickhouse": patch
"@chkit/plugin-pull": patch
"@chkit/plugin-obsessiondb": patch
---

`pull` then `generate` plans nothing, and `drift` reports nothing, on a database chkit migrated (#466).

- `pull` keeps every setting the server stores, including `index_granularity`, with a comment on the ones that cannot be altered on an existing table, and leaves out chkit's migration journal (`_chkit_migrations` or `CHKIT_JOURNAL_TABLE`) and the hidden `auto_minmax_index_*` skip indexes ClickHouse creates for the `add_minmax_index_for_*` settings.
- A MergeTree table without `index_granularity` is treated as having the server's default, the value ClickHouse stores, so new `CREATE TABLE` statements write `SETTINGS index_granularity = 8192`. Existing projects plan nothing for it. A server with another `<merge_tree><index_granularity>` sets it in the new `clickhouse.indexGranularity` config value (default 8192). `drift`, `check`, `migrate` and `pull` stop when the server's default differs from it, with a message that names the value to set.
- Setting values compare by value (`4096` and `"4096"`, `2.0` and `2.`, `true` and `1`), exactly, so a change between two large integers is not lost. A literal column default compares by value with the expression pull reads back (`7` and `{ expression: '7' }`, `"it's"` and `'it\'s'`, `1e21` and `1e+21`, newlines and tabs as ClickHouse escapes them), in `generate` and in `drift`. A string escape chkit does not know for certain (`\N`, `\u0041`) compares as text.
- A column type compares in the spacing ClickHouse stores (`Decimal(10,2)` and `Decimal(10, 2)`) in `generate` and `drift`; text in quotes compares as written. Skip indexes, projections, constraints and columns compare whatever order their keys are written in.
- A change to a setting ClickHouse cannot alter on an existing table (`index_granularity`, `index_granularity_bytes`, the `add_minmax_index_for_*` settings and others) plans `DROP TABLE` and `CREATE TABLE`, like an `ORDER BY` change, instead of an `ALTER` the server rejects. `--cutover` supports such a change: its swap guards now also tell the old table from the new one by these settings, and its first statement checks that the table stores the read-only settings the migration expects before anything is created or copied.
- On an ObsessionDB host, the ObsessionDB plugin treats a table without `storage_policy` as `storage_policy: "'s3'"`, the policy ObsessionDB writes into every `Shared` table, in the schema and the snapshot, and `generate` rejects a schema that changes it. A new `onSnapshotLoaded` plugin hook applies a plugin's schema rewrite to the previous snapshot, so a snapshot written before the rewrite plans no change, and dropping `--force-shared-engines` no longer plans a `RESET SETTING storage_policy`.
- A dictionary `lifetime` compares in the form ClickHouse stores (`300` and `MIN 0 MAX 300`), and dictionaries compare whatever order their keys are written in.
