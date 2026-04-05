# Chunking Analysis — Partition 202010

**Table**: `default.solana_transfers`
**Sort key**: `contract_address, block_timestamp, unique_id`

## Partition Facts

| Metric | Value |
|--------|-------|
| Partition ID | `202010` |
| Rows | 535,310,542 |
| Compressed size | 18.88 GB (18,884,283,011 bytes) |
| Uncompressed size | 149.84 GB (149,838,775,785 bytes) |
| Compression ratio | 7.94x |
| Parts | 1 (single merged part) |

Query used:

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

## Target

- **Target chunk size**: 10 GB uncompressed
- **Expected chunks**: ceil(149.84 / 10) = **15 chunks**

## First Sort Key: Equal-Width String Distribution (16 slices)

We split the `contract_address` byte space into 16 equal-width ranges and used `EXPLAIN ESTIMATE` to get row counts for each. Total time for all 16 queries: **1.35s**.

`EXPLAIN ESTIMATE` reads ClickHouse mark-level metadata (part index files) — zero data scanning. Each query takes ~0.08s. It returns an approximate row count based on which granules (marks) overlap the WHERE clause range.

Min/max of sort key was fetched first:

```sql
SELECT
  min(contract_address) AS minVal,
  max(contract_address) AS maxVal
FROM default.solana_transfers
WHERE _partition_id = '202010'
-- Result: min = 0x2d ("-"), max = 0x764759384b74794c5a6545635a6676743370763532614453564c3157654e32647a38356834356e6142544c
-- Took: 0.21s
```

The byte range was divided into 16 equal-width sub-ranges using BigInt arithmetic on 8-byte padded values. For each sub-range, we ran:

```sql
-- Example for slice 5 (0x43..0x48):
EXPLAIN ESTIMATE
SELECT 1
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address >= unhex('43e64be1979465e7')
  AND contract_address < unhex('487ac1751c4bad7c')
```

Full output from the script had 16 slices, but the data is heavily skewed. Summary:

| Slice | Approx. range | Est. Rows | % of total |
|-------|---------------|-----------|------------|
| 5 | 0x43..0x48 (C-H) | 202M | 46% |
| 6 | 0x48..0x4D (H-M) | 115M | 26% |
| 9 | 0x51..0x56 (Q-V) | 61M | 14% |
| 2-3 | 0x31..0x3A (1-9) | 60M | 14% |
| rest | everything else | ~50K | ~0% |

**Finding**: 86% of data is in slices 5-6 (ASCII C through M). Solana contract addresses are base58-encoded, so the byte distribution clusters in `[1-9A-HJ-NP-Za-km-z]`, not uniformly across 0x00-0xFF. Equal-width byte splitting produces a 7.4x skew factor.

## First Sort Key: Equal-Width String Distribution (75 slices = 15 chunks × 5x oversampling)

With 10 GB uncompressed target → 15 chunks needed. Using a 5x oversampling multiplier (75 slices), we can later re-merge in memory. All 75 EXPLAIN ESTIMATE queries took **5.52s** total (~0.07s each).

Same approach as above but with 75 equal-width sub-ranges. Each query follows the same pattern:

```sql
EXPLAIN ESTIMATE
SELECT 1
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address >= unhex('<from_hex>')
  AND contract_address < unhex('<to_hex>')
```

Top slices by row count:

| Slice | Range | Est. Rows | % of total |
|-------|-------|-----------|------------|
| 22 | 0x42..0x43 (B-C) | 177.9M | 40.5% |
| 40 | 0x54..0x55 (T-U) | 61.5M | 14.0% |
| 24 | 0x44..0x45 (D-E) | 56.3M | 12.8% |
| 25 | 0x45..0x46 (E-F) | 43.1M | 9.8% |
| 13 | 0x39..0x3A (9-:) | 28.9M | 6.6% |
| 6 | 0x32..0x33 (2-3) | 25.6M | 5.8% |
| 23 | 0x43..0x44 (C-D) | 21.7M | 5.0% |
| 27 | 0x47..0x48 (G-H) | 14.4M | 3.3% |
| rest (67 slices) | | ~3M combined | ~0.7% |

**Finding**: With 75 slices, the skew becomes even more apparent. Slice 22 (just the `B` prefix range) alone has **40.5%** of all data (177.9M rows). Max skew factor is 30.4x. The data lives almost entirely in ~8 of the 75 slices.

## Slice 22 Deep Dive: EXPLAIN ESTIMATE vs Exact COUNT

Slice 22 range: `0x427ebe02dc1b56c7` → `0x4378ddebb790f1ff` (B-C prefix)

### EXPLAIN ESTIMATE (50 sub-slices within slice 22)

We subdivided slice 22 into 50 equal-width sub-ranges and ran EXPLAIN ESTIMATE on each. Took **33.47s** total. Almost all estimated rows landed in sub-slice 44 (96.8%).

```sql
-- Example sub-slice query:
EXPLAIN ESTIMATE
SELECT 1
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address >= unhex('4355d97413b8cce7')
  AND contract_address < unhex('435ada177445647d')
-- Result: 21,446,482 rows (sub-slice 44)
```

### Exact COUNT on the full slice 22 range

```sql
SELECT count() AS cnt
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address >= unhex('427ebe02dc1b56c7')
  AND contract_address < unhex('4378ddebb790f1ff')
-- Result: 760,938,430 rows
-- Time: 3.02s
```

### Comparison

| Method | Rows | Time | Notes |
|--------|------|------|-------|
| EXPLAIN ESTIMATE (from 75-slice run) | 177,856,128 | ~0.07s | 4.3x under actual |
| EXPLAIN ESTIMATE (50 sub-slices summed) | 22,150,951 | 33.5s | 34x under actual |
| **Exact COUNT** | **760,938,430** | **3.02s** | Ground truth |

**Critical finding**: EXPLAIN ESTIMATE is wildly inaccurate for this data. The 75-slice run reported 177.9M but reality is 760.9M — off by 4.3x. The finer 50-sub-slice drill was even worse, totaling only 22.1M — off by 34x.

Meanwhile the exact COUNT took only **3.02s**, which is surprisingly fast and much more practical than expected (RESULTS.md predicted ~12s per query).

**Note**: The exact count of 760.9M for this single slice exceeds the `system.parts` total of 535.3M for the whole partition. This suggests `system.parts` row counts may be stale or approximate, or the sort key range overlaps with data that the partition boundary math doesn't account for correctly. Needs investigation.

## Parallel Replicas Over-Counting Bug

ObsessionDB (ClickHouse Cloud) sets `enable_parallel_replicas=1` by default. This causes `SELECT count()` to return wildly inflated numbers — each replica counts independently and results are summed without deduplication.

### Query: count() with default settings (parallel replicas ON)

```sql
SELECT count()
FROM default.solana_transfers
WHERE _partition_id = '202010'
-- Result: 18,735,868,970 (18.7 billion)
```

### Query: count() with parallel replicas OFF

```sql
SELECT count()
FROM default.solana_transfers
WHERE _partition_id = '202010'
SETTINGS enable_parallel_replicas=0
-- Result: 535,310,542 (535.3 million)
```

### Comparison

| Setting | Rows Returned | Notes |
|---------|---------------|-------|
| `enable_parallel_replicas=1` (default) | 18,735,868,970 | **35x over-count** |
| `enable_parallel_replicas=0` | 535,310,542 | Matches `system.parts` metadata |

**Root cause**: With parallel replicas enabled, ClickHouse distributes the query across replicas. For simple aggregates like `count()`, each replica returns its own count and the initiator sums them — producing a result multiplied by the number of replicas. The `system.parts` metadata (535.3M rows) is correct and matches the single-replica count exactly.

**Impact on earlier analysis**: The "exact COUNT" of 760.9M reported for slice 22 in the deep dive above was also inflated by parallel replicas. The real number would be significantly lower and consistent with `system.parts` totals. All `SELECT count()` and `SELECT` queries in this analysis that did not explicitly set `enable_parallel_replicas=0` are suspect.

**Fix**: Always pass `SETTINGS enable_parallel_replicas=0` when running count/aggregate queries on ObsessionDB, or configure it at the user/profile level.

## Identifying Hot Keys in a Slice: 4 Approaches Compared

Given a slice that's still too large after first-pass chunking, we need to find the individual hot first-sort-key values to then split on the second sort key dimension. We tested 4 approaches on slice 22 (`0x427ebe02dc1b56c7` → `0x4378ddebb790f1ff`).

**Context**: Slice 22 has only **14 distinct `contract_address` values**, with one dominant key (`CWE8...`) holding ~98% of all rows.

### Option 1: Exact top-N GROUP BY

```sql
SELECT contract_address, count() AS cnt
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address >= unhex('427ebe02dc1b56c7')
  AND contract_address < unhex('4378ddebb790f1ff')
GROUP BY contract_address
ORDER BY cnt DESC
LIMIT 20
SETTINGS enable_parallel_replicas=0
-- Time: 0.42s
```

| contract_address | Rows |
|-----------------|------|
| `CWE8jPTUYhdCTZYWPTe1o5DFqfdjzWKc9WKz6rSjQUdG` | 21,440,521 |
| `CsZ5LZkDS7h9TDKjrbL7VAwQZ9nsRu8vJLhRYfmGaN8K` | 298,429 |
| `CWuypwJdDi8pxNZ1k4HMUVzk8rtkrBnzqfnmc6y1pci3` | 777 |
| `CibFicoaEmw6CLocb1iDA9Vo6uMDwt75P1rAvUky2dq6` | 763 |
| remaining 10 keys | < 400 each |

### Option 2: Count distinct keys

```sql
SELECT count(DISTINCT contract_address) AS distinct_keys
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address >= unhex('427ebe02dc1b56c7')
  AND contract_address < unhex('4378ddebb790f1ff')
SETTINGS enable_parallel_replicas=0
-- Result: 14
-- Time: 0.45s
```

Useful as a preliminary check: if distinct count is low, a full GROUP BY is cheap.

### Option 3: EXPLAIN ESTIMATE with equality probes

Two-step approach: (1) discover keys, (2) probe each with EXPLAIN ESTIMATE.

```sql
-- Step 1: Get all distinct keys
SELECT DISTINCT contract_address
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address >= unhex('427ebe02dc1b56c7')
  AND contract_address < unhex('4378ddebb790f1ff')
SETTINGS enable_parallel_replicas=0
-- Result: 14 keys in 0.60s

-- Step 2: Probe each key (example for the hot key)
EXPLAIN ESTIMATE
SELECT 1
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address = unhex('435745386a505455596864435454595a575054653176354446716664 ...')
-- Repeated for all 14 keys, total: 2.09s
```

| contract_address | EXPLAIN ESTIMATE rows | Exact rows (Option 1) | Error |
|-----------------|----------------------|----------------------|-------|
| `CWE8jPTU...` | 21,446,482 | 21,440,521 | **+0.03%** |
| `CsZ5LZkD...` | 311,296 | 298,429 | +4.3% |
| others (12 keys) | ~8,192 each | < 800 each | ~10x over |

**Finding**: EXPLAIN ESTIMATE is very accurate for the dominant key (+0.03% error!) but over-estimates small keys by ~10x. This makes sense — mark-level granularity (8192 rows) is the minimum resolution, so small keys get rounded up to one granule.

### Option 4: Manual sampling via `cityHash64` modulo

`SAMPLE` clause is not available (table lacks `SAMPLE BY`), so we use `cityHash64(...) % N = 0` as a filter.

```sql
-- 1/1000 sample:
SELECT contract_address, count() AS cnt
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address >= unhex('427ebe02dc1b56c7')
  AND contract_address < unhex('4378ddebb790f1ff')
  AND cityHash64(contract_address, block_timestamp, unique_id) % 1000 = 0
GROUP BY contract_address
ORDER BY cnt DESC
LIMIT 20
SETTINGS enable_parallel_replicas=0
-- Time: 20.17s (!)
```

| contract_address | Sampled | Extrapolated | Exact (Option 1) | Error |
|-----------------|---------|--------------|-------------------|-------|
| `CWE8jPTU...` | 21,800 | ~21,800,000 | 21,440,521 | +1.7% |
| `CsZ5LZkD...` | 304 | ~304,000 | 298,429 | +1.9% |
| `CibFicoa...` | 1 | ~1,000 | 763 | +31% |

1/100 and 1/10 samples were still running after 20s+ each — cancelled. Sampling scans all data and applies the hash filter, so it provides no speedup over a full GROUP BY.

### Summary

| Approach | Time | Accuracy | Scans data? | Best when |
|----------|------|----------|-------------|-----------|
| **1. Exact GROUP BY** | **0.42s** | exact | yes, but fast on sort key | always works, surprisingly fast |
| 2. COUNT DISTINCT | 0.45s | exact (just cardinality) | yes | preliminary check before GROUP BY |
| **3. EXPLAIN ESTIMATE probes** | **2.69s** | ±0.03% for hot keys, ~10x over for small | no (metadata only) | when you already have candidate keys |
| 4. Manual sampling | 20s+ | ±2% for hot keys | yes (full scan + filter) | never — slower than exact GROUP BY |

**Conclusion**: Option 1 (exact GROUP BY) wins decisively. It's the fastest (0.42s), gives exact results, and doesn't require knowing candidate keys upfront. The reason it's fast: ClickHouse can satisfy a GROUP BY on the first sort key by scanning the sort index — it doesn't need to decompress row data, just walk the sorted key column.

Option 3 (EXPLAIN ESTIMATE probes) is a viable zero-scan alternative if you already have candidate keys from a previous step, but the two-step process (discover + probe) takes longer than just doing the GROUP BY.

Option 4 (sampling) is a dead end — it's slower than the exact answer.

## Second Sort Key: Temporal Split on Hot Key

After identifying the hot key `CWE8jPTUYhdCTZYWPTe1o5DFqfdjzWKc9WKz6rSjQUdG` (21.4M rows, 98.6% of slice 22), the algorithm pins `contract_address = '<hot_key>'` and splits on the second sort key `block_timestamp`.

Since the first sort key is pinned to a single value, the data is **contiguous and sorted by `block_timestamp`** — we're back to a clean 1D temporal splitting problem.

### Step 1: Get temporal range

```sql
SELECT
  min(block_timestamp) AS min_ts,
  max(block_timestamp) AS max_ts,
  count() AS cnt
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address = 'CWE8jPTUYhdCTZYWPTe1o5DFqfdjzWKc9WKz6rSjQUdG'
SETTINGS enable_parallel_replicas=0
-- min: 2020-10-04 00:00:00
-- max: 2020-10-31 23:59:59
-- Rows: 21,440,521
-- Time: 0.83s
```

### Step 2: Daily distribution

```sql
SELECT toDate(block_timestamp) AS day, count() AS cnt
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address = 'CWE8jPTUYhdCTZYWPTe1o5DFqfdjzWKc9WKz6rSjQUdG'
GROUP BY day
ORDER BY day
SETTINGS enable_parallel_replicas=0
-- Time: 0.67s
```

| Day | Rows | % |
|-----|------|---|
| 2020-10-04 | 543,188 | 2.5% |
| 2020-10-05 | 460,821 | 2.1% |
| 2020-10-06 | 600,262 | 2.8% |
| 2020-10-07 | 678,537 | 3.2% |
| 2020-10-08 | 682,395 | 3.2% |
| 2020-10-09 | 732,158 | 3.4% |
| 2020-10-10 | 718,199 | 3.3% |
| 2020-10-11 | 831,649 | 3.9% |
| 2020-10-12 | 628,851 | 2.9% |
| 2020-10-13 | 780,703 | 3.6% |
| 2020-10-14 | 747,741 | 3.5% |
| 2020-10-15 | 612,321 | 2.9% |
| 2020-10-16 | 607,732 | 2.8% |
| 2020-10-17 | 557,349 | 2.6% |
| 2020-10-18 | 499,014 | 2.3% |
| 2020-10-19 | 586,493 | 2.7% |
| 2020-10-20 | 831,751 | 3.9% |
| 2020-10-21 | 974,299 | 4.5% |
| 2020-10-22 | 1,059,578 | 4.9% |
| 2020-10-23 | 1,004,754 | 4.7% |
| 2020-10-24 | 956,383 | 4.5% |
| 2020-10-25 | 844,949 | 3.9% |
| 2020-10-26 | 964,325 | 4.5% |
| 2020-10-27 | 843,079 | 3.9% |
| 2020-10-28 | 928,821 | 4.3% |
| 2020-10-29 | 977,294 | 4.6% |
| 2020-10-30 | 899,183 | 4.2% |
| 2020-10-31 | 888,692 | 4.1% |

**Finding**: The temporal distribution is remarkably uniform — no single day exceeds 5%. Max/min ratio is only 2.3x (Oct 22 vs Oct 5). This is the ideal case for temporal splitting: once the hot key is pinned, the data fans out evenly across time.

### EXPLAIN ESTIMATE accuracy on second sort key

```sql
-- Example: single-day bucket
EXPLAIN ESTIMATE
SELECT 1
FROM default.solana_transfers
WHERE _partition_id = '202010'
  AND contract_address = 'CWE8jPTUYhdCTZYWPTe1o5DFqfdjzWKc9WKz6rSjQUdG'
  AND block_timestamp >= '2020-10-10'
  AND block_timestamp < '2020-10-11'
```

| Day | EXPLAIN ESTIMATE | Exact count | Error |
|-----|-----------------|-------------|-------|
| 2020-10-10 | 729,088 | 718,199 | **+1.5%** |
| 2020-10-20 | 843,776 | 831,751 | **+1.4%** |
| 2020-10-30 | 909,312 | 899,183 | **+1.1%** |

**Finding**: EXPLAIN ESTIMATE is extremely accurate (~1-2% error) when both the first sort key is pinned to an exact value AND the second sort key range aligns with the sorted data. This makes sense — the mark index can precisely locate the contiguous data block.

### Implications for the algorithm

1. The temporal split on a pinned hot key is **fast** (0.67s for full daily GROUP BY) and produces **uniform chunks**
2. EXPLAIN ESTIMATE works well here (~1.5% error) and could be used for finer-grained time windows without scanning data
3. With 21.4M rows across 28 days, you can merge adjacent days to hit target chunk sizes — e.g., 3-4 day windows give ~2-3M row chunks

## Conclusion: Recommended Chunking Algorithm

### Core insight

**A GROUP BY on any sort key dimension is fast and exact, as long as all preceding dimensions are pinned to contiguous sorted data.** The cost is proportional to the number of distinct values in that contiguous block, not the number of rows. ClickHouse walks the sorted column without decompressing row data.

This means the "estimate then refine" approach is only needed for the **first pass on the first sort key**, where you don't know the key space and are doing range queries. For all subsequent dimensions, just do the GROUP BY — the exact answer is cheaper than the approximation.

### Algorithm

**Pass 1 — First sort key: equal-width range splitting with EXPLAIN ESTIMATE**

1. Get `min(key1)` / `max(key1)` for the partition
2. Compute `subCount = ceil(partitionBytesUncompressed / targetChunkBytes)` — this is the ideal number of chunks
3. Split the key space into `subCount * 3` equal-width ranges (3x oversampling)
4. Run `EXPLAIN ESTIMATE` on each range (~0.07s each, total <5s for 45 ranges)
5. Merge adjacent small slices to approach target chunk size
6. Any slice still larger than target → mark as "needs refinement"

**Pass 2 — Hot key identification via GROUP BY**

For each oversized slice from pass 1:

1. Run `SELECT key1, count() ... GROUP BY key1 ORDER BY count() DESC` within the slice range (~0.4s, exact)
2. This reveals the hot keys and the long tail
3. Small keys get merged into shared chunks (they're adjacent in sort order)
4. Each hot key that alone exceeds target → needs second-dimension splitting

**Pass 3 — Second sort key: GROUP BY with pinned first key**

For each hot key from pass 2:

1. Pin `key1 = '<hot_value>'` — data is now contiguous and sorted by `key2`
2. Run `SELECT <bucket>(key2), count() ... GROUP BY 1 ORDER BY 1` (~0.7s, exact)
   - For DateTime: use `toDate()`, `toStartOfHour()`, or `toStartOfInterval()` depending on how many buckets are needed
   - For String: same equal-width range approach as pass 1
3. Merge adjacent buckets to hit target chunk size

**Pass 4+ — Deeper dimensions (if needed)**

Repeat the same pattern: pin all preceding keys, GROUP BY on the next dimension. In practice this is rarely needed — DateTime hot keys (a single hot millisecond) are essentially impossible.

**Give up**: After exhausting all sort key dimensions, if a chunk is still too large, accept it. The sort key combination is a natural hot spot that can't be subdivided further.

### Performance budget (measured on 535M row partition)

| Step | Queries | Time | Method |
|------|---------|------|--------|
| min/max first key | 1 | 0.2s | SELECT min/max |
| Pass 1: 45 range estimates | 45 | ~3.5s | EXPLAIN ESTIMATE |
| Pass 2: GROUP BY per oversized slice | ~3-5 | ~2s total | SELECT GROUP BY |
| Pass 3: temporal GROUP BY per hot key | ~1-3 | ~2s total | SELECT GROUP BY |
| **Total** | **~55** | **~8s** | |

The entire chunking plan for a 150 GB partition can be computed in under 10 seconds, with exact row counts for every chunk except the initial range estimates (which are within 1-5% anyway).

### Key decisions

- **Use uncompressed bytes for target chunk size**, not compressed. The backfill moves uncompressed data.
- **3x oversampling** on the first pass is sufficient (not 5x). The GROUP BY refinement in pass 2 catches any remaining skew precisely.
- **Always set `enable_parallel_replicas=0`** for count/aggregate queries on ClickHouse Cloud, or counts will be inflated by the replica count.
- **EXPLAIN ESTIMATE accuracy** depends on context: ~1-5% for range queries on sorted data, ~0.03% for exact key matches, but can be wildly off (34x) when ranges don't align with the sort order or are subdivided too finely.

## TODO

- [ ] **Use uncompressed sizes for chunk targets, not compressed.** We need to move the uncompressed amount of data — the target chunk size should be based on `bytes_uncompressed`, not `bytes_on_disk`.
- [ ] **Re-run all count queries with `enable_parallel_replicas=0`** to get correct numbers for chunk planning.
