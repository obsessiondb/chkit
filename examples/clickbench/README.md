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

## Dependency security

This example uses published chkit packages. Its exact oRPC overrides replace the
vulnerable versions pinned by those older releases, including when the example is
copied outside the monorepo. The root manifest repeats these overrides because
Bun uses the workspace root's overrides for in-repo installs. Keep both sets in
sync until the example's published chkit dependencies include the patched oRPC
versions.
