# ClickBench CHKit example

This example creates the ClickBench `hits` schema and loads the full public ClickBench dataset from the ObsessionDB-hosted mirror at `fsn1.your-objectstorage.com/obsessiondb-datasets/clickbench/`.

The data load migration truncates `default.hits` before inserting so an interrupted load can be retried by clearing the migration journal entry or using a fresh database. Run it against a disposable ClickHouse database.

## Run

```bash
cd examples/clickbench
bun install
CLICKHOUSE_URL=http://localhost:8123 bun run migrate
```

For ObsessionDB, authenticate/select a service as usual and pass the service flag:

```bash
cd examples/clickbench
bun install
bunx chkit obsessiondb login
bunx chkit obsessiondb service select
bun run migrate -- --service <service-name-or-alias>
```

## Migrations

- `20260525133129_create_clickbench_schema.sql` creates the ClickBench `hits` table.
- `20260525133130_load_clickbench_data.sql` truncates `hits` and loads the full partitioned Parquet dataset from `https://fsn1.your-objectstorage.com/obsessiondb-datasets/clickbench/` via ClickHouse's `s3()` table function.

The benchmark query set is intentionally not included yet; this example focuses on schema creation and dataset loading.
