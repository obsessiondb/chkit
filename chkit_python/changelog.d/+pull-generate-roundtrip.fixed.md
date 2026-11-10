`pull` then `generate` plans nothing, and `drift` reports nothing, on a database chkit
migrated (#466, fixed in TS too). `pull` keeps every setting the server stores, including
`index_granularity`, and leaves out chkit's migration journal and the hidden
`auto_minmax_index_*` skip indexes. A MergeTree table without `index_granularity` is treated
as having the server's default, so new `CREATE TABLE` statements write it: 8192, or the new
`clickhouse` config value `indexGranularity` for a server with another
`<merge_tree><index_granularity>`. `drift`, `check`, `migrate` and `pull` stop when the
server's default differs from it. Setting values and literal column defaults compare by
value, exactly (`2.0` and `2.`, `true` and `1`, `"it's"` and `'it\'s'`, `1e21` and
`1e+21`), in `generate` and `drift`; a string escape chkit does not know for certain
compares as text. Column types compare in the spacing ClickHouse stores (`Decimal(10,2)`
and `Decimal(10, 2)`). A float default or setting renders as TS writes it (`0.00001`, not
`1e-05`). A change to a setting ClickHouse cannot alter on an existing table plans
`DROP TABLE` and `CREATE TABLE` instead of an `ALTER` the server rejects, and `--cutover`
supports it; its first statement checks that the table stores the read-only settings the
migration expects. `pull` comments the settings that cannot change. On an ObsessionDB host the ObsessionDB plugin
treats a table without `storage_policy` as `'s3'`, in the schema and, through a new
`on_snapshot_loaded` plugin hook, the snapshot, and `generate` rejects a change to it. A
dictionary `lifetime` compares in the form ClickHouse stores.
