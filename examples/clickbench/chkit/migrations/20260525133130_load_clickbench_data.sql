-- chkit-migration-format: v1
-- generated-at: 2026-05-25T13:31:29.295Z
-- cli-version: 0.1.0-beta.24
-- definition-count: 1
-- operation-count: 6
-- rename-suggestion-count: 0
-- risk-summary: safe=0, caution=6, danger=0

-- operation: truncate_table key=table:default.hits risk=caution
TRUNCATE TABLE default.hits SETTINGS max_table_size_to_drop = 0, max_partition_size_to_drop = 0;

-- The full ClickBench Parquet dataset is split into 100 files (hits_0..99).
-- We load it in five 20-file chunks so each INSERT stays under upstream
-- request-duration limits (e.g. proxy/load-balancer timeouts in front of
-- ClickHouse). max_execution_time = 0 disables the server-side query timeout
-- since the load is intentionally long-running.

-- operation: load_table_data key=table:default.hits risk=caution
INSERT INTO default.hits
SELECT * FROM url('https://datasets.clickhouse.com/hits_compatible/athena_partitioned/hits_{0..19}.parquet', 'Parquet')
SETTINGS max_execution_time = 0;

-- operation: load_table_data key=table:default.hits risk=caution
INSERT INTO default.hits
SELECT * FROM url('https://datasets.clickhouse.com/hits_compatible/athena_partitioned/hits_{20..39}.parquet', 'Parquet')
SETTINGS max_execution_time = 0;

-- operation: load_table_data key=table:default.hits risk=caution
INSERT INTO default.hits
SELECT * FROM url('https://datasets.clickhouse.com/hits_compatible/athena_partitioned/hits_{40..59}.parquet', 'Parquet')
SETTINGS max_execution_time = 0;

-- operation: load_table_data key=table:default.hits risk=caution
INSERT INTO default.hits
SELECT * FROM url('https://datasets.clickhouse.com/hits_compatible/athena_partitioned/hits_{60..79}.parquet', 'Parquet')
SETTINGS max_execution_time = 0;

-- operation: load_table_data key=table:default.hits risk=caution
INSERT INTO default.hits
SELECT * FROM url('https://datasets.clickhouse.com/hits_compatible/athena_partitioned/hits_{80..99}.parquet', 'Parquet')
SETTINGS max_execution_time = 0;
