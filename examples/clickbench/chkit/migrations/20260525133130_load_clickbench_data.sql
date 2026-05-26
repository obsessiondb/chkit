-- chkit-migration-format: v1
-- log: Loading the full ClickBench dataset (~100M rows from S3). Expected duration: 3-5 minutes.
-- generated-at: 2026-05-25T13:31:29.295Z
-- cli-version: 0.1.0-beta.24
-- definition-count: 1
-- operation-count: 2
-- rename-suggestion-count: 0
-- risk-summary: safe=0, caution=2, danger=0

-- operation: truncate_table key=table:default.hits risk=caution
TRUNCATE TABLE default.hits SETTINGS max_table_size_to_drop = 0, max_partition_size_to_drop = 0;

-- Load the full ClickBench dataset (100 Parquet files, ~100M rows) in a single
-- INSERT. We use the s3() table function against the ObsessionDB-hosted mirror
-- of the dataset (Hetzner Object Storage, FSN1 region) because s3() does
-- native partitioned-Parquet parallelism that url() does not.
--
-- Tuning (measured against an ObsessionDB customer-benchmark instance):
--   * max_download_threads = 64, max_insert_threads = 16 lands at ~178s for
--     the full 100M rows. Higher concurrency (e.g. 128/32) is ~10% faster but
--     trips the server's OvercommitTracker under shared load.
--   * max_memory_usage = 6.5 GiB is a hard ceiling on this query alone, well
--     under the 7.2 GiB-ish OvercommitTracker threshold typical of managed
--     ClickHouse deployments. If a smaller instance is used, lower this and
--     drop concurrency to (32, 16) or (16, 8) accordingly.
--   * max_execution_time = 0 lifts the server-side query timer (the load is
--     intentionally long-running).

-- operation: load_table_data key=table:default.hits risk=caution
INSERT INTO default.hits
SELECT *
FROM s3(
  'https://fsn1.your-objectstorage.com/obsessiondb-datasets/clickbench/hits_{0..99}.parquet',
  'Parquet'
)
SETTINGS
  max_execution_time = 0,
  max_memory_usage = 6500000000,
  max_download_threads = 64,
  max_insert_threads = 16;
