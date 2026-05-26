-- chkit-migration-format: v1
-- generated-at: 2026-05-25T13:31:29.295Z
-- cli-version: 0.1.0-beta.24
-- definition-count: 1
-- operation-count: 2
-- rename-suggestion-count: 0
-- risk-summary: safe=0, caution=2, danger=0

-- operation: truncate_table key=table:default.hits risk=caution
TRUNCATE TABLE default.hits SETTINGS max_table_size_to_drop = 0, max_partition_size_to_drop = 0;

-- Load the full ClickBench dataset (100 Parquet files, ~100M rows) in a single
-- INSERT. We use the s3() table function against the public dataset bucket
-- (datasets.clickhouse.com is a CloudFront alias for clickhouse-public-datasets)
-- because s3() does native partitioned-Parquet parallelism that url() does not.
-- max_download_threads parallelises the fetch across the 100 files;
-- max_insert_threads parallelises the write side; max_execution_time = 0 lifts
-- the server-side query timer.

-- operation: load_table_data key=table:default.hits risk=caution
INSERT INTO default.hits
SELECT *
FROM s3(
  'https://clickhouse-public-datasets.s3.amazonaws.com/hits_compatible/athena_partitioned/hits_{0..99}.parquet',
  'Parquet'
)
SETTINGS
  max_execution_time = 0,
  max_download_threads = 32,
  max_insert_threads = 16;
