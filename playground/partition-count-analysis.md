# Partition 202010 Row Count Analysis

**Date:** 2026-04-03
**Table:** `default.solana_transfers`
**Partition:** `202010`

## Query 1: `system.parts` metadata

```sql
SELECT
  partition_id,
  toString(sum(rows)) AS total_rows,
  toString(sum(bytes_on_disk)) AS bytes_compressed,
  toString(sum(data_uncompressed_bytes)) AS bytes_uncompressed,
  toString(count()) AS num_parts
FROM system.parts
WHERE database = 'default'
  AND table = 'solana_transfers'
  AND partition_id = '202010'
  AND active = 1
GROUP BY partition_id
```

| partition_id | total_rows | bytes_compressed | bytes_uncompressed | num_parts |
|---|---|---|---|---|
| 202010 | **535,310,542** | 18,884,283,011 (~17.6 GB) | 149,838,775,785 (~139.5 GB) | 1 |

## Query 2: `EXPLAIN ESTIMATE`

```sql
EXPLAIN ESTIMATE
SELECT 1
FROM default.solana_transfers
WHERE _partition_id = '202010'
```

| database | table | parts | rows | marks |
|---|---|---|---|---|
| default | solana_transfers | 1 | **535,310,542** | 65,403 |

## Query 3: `SELECT count()`

```sql
SELECT count()
FROM default.solana_transfers
WHERE _partition_id = '202010'
```

| count() |
|---|
| **18,735,868,970** |

## Analysis

There is a **massive discrepancy** between the row counts:

| Source | Row Count | Notes |
|---|---|---|
| `system.parts` metadata | **535,310,542** (~535M) | Part-level metadata |
| `EXPLAIN ESTIMATE` | **535,310,542** (~535M) | Uses part metadata for estimation |
| `SELECT count()` | **18,735,868,970** (~18.7B) | Actual scan result |

The actual `count()` returns **~35x more rows** than what `system.parts` reports.

### What this means

- `system.parts` and `EXPLAIN ESTIMATE` both agree at ~535M rows — they both read part-level metadata, not actual data.
- The real `SELECT count()` scans the data and finds ~18.7B rows.
- This suggests the part metadata (`rows` column in `system.parts`) is **severely undercounting** the actual number of rows in the partition.

### Possible causes

1. **Metadata corruption / stale metadata** — The part was mutated (e.g., via `ALTER UPDATE`, `ALTER DELETE`, or lightweight deletes) and the `rows` metadata was not updated to reflect the actual row count.
2. **Bug in ObsessionDB / ClickHouse Cloud** — A platform-level issue where part metadata diverges from actual data after certain operations (merges, mutations, replicated inserts).
3. **Duplicated data within the part** — If data was inserted multiple times and merges happened in a way that inflated the actual rows without updating metadata.

### Impact

Any system relying on `system.parts` row counts (e.g., backfill chunking, progress estimation, partition sizing) will **dramatically underestimate** the amount of data in this partition. A chunk expecting 535M rows will actually process 18.7B rows — a 35x difference that could cause timeouts, OOMs, or incorrect progress reporting.
