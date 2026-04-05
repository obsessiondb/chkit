# Chunking Strategy Benchmark Results

**Table**: `default.solana_transfers`
**Partition**: `202010` (Oct 2020)
**Rows**: 535,310,542
**Size**: 18.88 GB compressed
**Sort key**: `contract_address, block_timestamp, unique_id`
**Parts**: 1 (single part, 65,404 marks, ~8,185 rows/mark)

## Strategy Comparison

| Strategy | Total Duration | Queries | Avg/Query | Notes |
|----------|---------------|---------|-----------|-------|
| **String Prefix (depth 1)** | **>60s (killed)** | 1 | >60s | Full partition GROUP BY - this is the slow query from the logs |
| **Temporal Bucket (day)** | **>60s (killed)** | 1 | >60s | GROUP BY toStartOfDay - equally slow |
| **Exact COUNT (single sub-range)** | **12.42s** | 1 | 12.42s | Binary search with this = ~5min for 24 steps |
| **EXPLAIN ESTIMATE (equal-width 4)** | **0.32s** | 4 | 0.08s | Fast metadata-only query |
| **EXPLAIN ESTIMATE (equal-width 8)** | **0.69s** | 8 | 0.09s | Scales linearly |
| **EXPLAIN ESTIMATE (equal-width 16)** | **3.30s** | 16 | 0.21s | Still fast |
| **EXPLAIN ESTIMATE (equal-width 32)** | **27.19s** | 32 | 0.85s | Getting slower at high counts |
| **EXPLAIN ESTIMATE (256-way byte split)** | **17.35s** | 256 | 0.07s | 75 non-empty buckets |
| **EXPLAIN ESTIMATE (binary search 24 steps)** | **1.36s** | 24 | 0.06s | Fastest for finding split points |
| **system.parts metadata** | **0.11s** | 1 | 0.11s | Zero scan, just row/byte totals |

## Key Findings

1. **GROUP BY queries are the bottleneck**: Both string prefix (`substring(col, 1, N)`) and temporal bucket (`toStartOfDay`) strategies require a full scan of 535M rows. On a single 18.8GB part, this takes >60 seconds per query. The string prefix strategy recursively deepens (depth 1-4), each depth issuing another GROUP BY, potentially making the total time >240s per partition slice.

2. **EXPLAIN ESTIMATE is 100-250x faster**: Uses mark-level metadata from part index files. Zero data scanning. A 24-step binary search using EXPLAIN ESTIMATE completes in 1.36s total.

3. **Exact COUNT is ~12s per query**: Still requires scanning data but no GROUP BY aggregation. A 24-step binary search with exact counts would take ~5 minutes — slow but finite.

4. **SAMPLE is unavailable**: SharedMergeTree doesn't support sampling, so that's not an option.

5. **Single part = no parallelism benefit**: The partition is a single merged part, so ClickHouse can't parallelize across parts.

## Recommendations

**For this hot partition scenario** (single large part, 535M rows, string sort key):

1. **Use EXPLAIN ESTIMATE for initial splitting** — The quantile binary search with EXPLAIN ESTIMATE (1.36s for 24 steps) can quickly find approximate split points. Then optionally refine with exact counts only on slices that need it.

2. **Avoid GROUP BY on the first pass** — The string prefix strategy should not be the first strategy tried on partitions this large. It's designed for cases where prefix distribution provides meaningful insight, but the cost is too high on 500M+ row partitions.

3. **Consider a size-gated strategy cascade** — For partitions above a threshold (e.g., >100M rows or >5GB), skip string prefix and temporal bucket entirely. Go straight to EXPLAIN ESTIMATE-based equal-width or quantile splitting.

4. **The equal-width + EXPLAIN ESTIMATE combo** is the best fit: 16-way split in 3.3s gives you usable sub-ranges that can then be refined.
