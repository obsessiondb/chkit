-- chkit-migration-format: v1
-- generated-at: 2026-05-25T13:31:29.295Z
-- cli-version: 0.1.0-beta.24
-- definition-count: 1
-- operation-count: 2
-- rename-suggestion-count: 0
-- risk-summary: safe=0, caution=2, danger=0

-- operation: truncate_table key=table:default.hits risk=caution
TRUNCATE TABLE default.hits;

-- operation: load_table_data key=table:default.hits risk=caution
INSERT INTO default.hits
SELECT *
FROM url(
  'https://datasets.clickhouse.com/hits_compatible/athena_partitioned/hits_{0..99}.parquet',
  'Parquet'
);
