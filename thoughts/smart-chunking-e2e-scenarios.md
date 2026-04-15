# Smart Chunking E2E Test Scenarios

Remaining scenarios to implement. Each gets its own table in the seed script and a `describe` block in `smart-chunking.e2e.test.ts`.

Implemented so far:
- [x] Scenario 1: Skewed Power Law (80/20 single hot key)
- [x] Scenario 2: Multiple Hot Keys (3 tenants at ~30% each)

---

## Scenario 3: Empty Ranges / Sparse Numeric Sort Key

**Table:** `chkit_e2e_chunking_sparse_numeric`
**Sort key:** `(id UInt64)`
**Partition by:** `toYYYYMM(event_time)`

**Dataset:**
- ~5,000 rows with `id` in range `[1, 10]`
- ~5,000 rows with `id` in range `[1_000_000, 1_000_010]`
- No values between 10 and 1,000,000
- Padding column for byte control

**What this tests:**
- Equal-width splitting will carve the huge numeric gap into many empty intervals
- Quantile binary search must handle the gap without producing empty chunks
- The system should not emit chunks with 0 rows
- After merge, only chunks covering the two clusters should remain
- Full row coverage despite the sparse distribution

**Key assertions:**
- No chunk has 0 estimated rows
- All chunks produced have `estimate.rows > 0`
- Total counted rows = total actual rows
- Chunk count is reasonable (not dozens of empty chunks)

---

## Scenario 4: Single Distinct Value in Sort Key

**Table:** `chkit_e2e_chunking_single_value`
**Sort key:** `(status String, seq UInt64)`
**Partition by:** `toYYYYMM(event_time)`

**Dataset:**
- 10,000 rows all with `status = 'active'`, `seq` 0-9999
- Single partition, padding for byte volume

**What this tests:**
- Every splitting strategy on dimension 0 should fail (quantile boundaries collapse, equal-width produces identical bounds, group-by-key returns 1 value)
- The system must fall through to dimension 1 (seq) and split there
- Or: produce a single chunk if seq splitting isn't needed
- Must not infinite-loop or error when no split is possible on dim 0

**Key assertions:**
- Plan completes without error
- If partition is oversized: chunks are split on dim 1 (seq), not dim 0
- Total counted rows = total actual rows
- No duplicate coverage

---

## Scenario 5: Very Long String Keys with Shared Prefixes

**Table:** `chkit_e2e_chunking_long_prefix`
**Sort key:** `(url String)`
**Partition by:** `toYYYYMM(event_time)`

**Dataset:**
- 10,000 rows where `url` follows pattern: `https://example.com/api/v2/resources/XXXX`
  where `XXXX` is a 4-digit incrementing ID (0000-9999)
- All values share a 39-character prefix; differ only in the last 4 characters
- Single partition

**What this tests:**
- `string-prefix-split` at depths 1-4 will see a single bucket (prefix is 39 chars)
- The system must fall through to quantile or equal-width splitting
- The dynamic BigInt width (from our fix) must handle 40+ char strings correctly
- Boundary computation must have enough precision in the suffix to split evenly

**Key assertions:**
- Plan completes, produces multiple chunks
- Chunks have boundaries that differentiate in the suffix portion
- Full row coverage
- No chunks with 0 rows (the long shared prefix shouldn't confuse the splitter)

---

## Scenario 6: DateTime Sort Key with Burst Traffic

**Table:** `chkit_e2e_chunking_datetime_burst`
**Sort key:** `(event_time DateTime)`
**Partition by:** `toYYYYMM(event_time)`

**Dataset:**
- 500 rows spread across 30 days of January 2026 (background traffic)
- 9,500 rows all within a single hour: `2026-01-15 14:00:00` to `2026-01-15 14:59:59`
- Single partition, padding for byte volume

**What this tests:**
- Day-level temporal bucketing produces one massive day and many tiny ones
- Hour-level fallback kicks in for Jan 15
- If 95% is within one hour, even hour-level bucketing can't split further
- Must fall through to quantile splitting on the datetime dimension itself
- Tests the full temporal cascade: day -> hour -> quantile

**Key assertions:**
- Plan completes, produces multiple chunks
- The burst hour is split into multiple chunks (not left as one oversized chunk)
- Background traffic days are merged into larger chunks (not 30 tiny chunks)
- Full row coverage
- Reasonable chunk sizes (within 2-3x target)

---

## Scenario 7: Three-Dimension Compound Key

**Table:** `chkit_e2e_chunking_three_dim`
**Sort key:** `(region String, tenant_id String, event_time DateTime)`
**Partition by:** `toYYYYMM(event_time)`

**Dataset:**
- 5 regions: `us-east`, `us-west`, `eu-west`, `ap-south`, `ap-east`
- Per region: 1 hot tenant with 1,500 rows + 10 small tenants with 10 rows each
- Hot tenant rows spread across 7 days in January 2026
- Total: 5 * (1500 + 100) = 8,000 rows

**What this tests:**
- Recursion through 3 dimensions (max depth = 3 * 3 = 9)
- Dimension 0 (region) splits into ~5 sub-ranges
- Dimension 1 (tenant_id) identifies hot tenant per region
- Dimension 2 (event_time) splits hot tenants by time
- Final chunks should carry ranges on all three dimensions

**Key assertions:**
- Plan completes within timeout
- Hot tenants are detected as focused values
- Some chunks have ranges on all 3 dimensions
- Full row coverage
- Chunk count is reasonable (not exponential blowup)

---

## Scenario 8: Partition at Exact Fuzz Factor Boundary

**Table:** `chkit_e2e_chunking_fuzz_boundary`
**Sort key:** `(id UInt64)`
**Partition by:** `toYYYYMM(event_time)`

**Dataset:**
- Two partitions (January and February 2026)
- January: rows sized to be exactly at `targetChunkBytes * 1.0`
- February: rows sized to be exactly at `targetChunkBytes * 1.6` (above the 1.5x fuzz factor)
- Controlled via row count and padding size

**What this tests:**
- The stop condition `<= target * 1.5`
- January partition (1.0x) should produce exactly 1 chunk
- February partition (1.6x) should be split into 2+ chunks
- Boundary arithmetic of the fuzz factor

**Key assertions:**
- January partition: exactly 1 chunk
- February partition: 2+ chunks
- Full row coverage in both partitions

**Implementation note:** This requires querying `system.parts` after seeding to learn the actual uncompressed bytes, then computing the target from the smaller partition's size. The seed might need iterative adjustment to hit the right byte ratio.

---

## Scenario 9: Mixed Type Sort Keys (Numeric + String)

**Table:** `chkit_e2e_chunking_mixed_types`
**Sort key:** `(priority UInt8, slug String)`
**Partition by:** `toYYYYMM(event_time)`

**Dataset:**
- `priority` has 3 distinct values: 1, 2, 3
- Priority 1: 1,000 rows with 100 distinct slugs
- Priority 2: 6,000 rows with 50 distinct slugs (hot priority)
- Priority 3: 3,000 rows with 200 distinct slugs
- Slugs are short strings like `item-XXXX`

**What this tests:**
- Numeric dimension with very low cardinality (3 values)
- Quantile splitting will likely collapse on dim 0 (only 3 values)
- Equal-width on dim 0 should produce 3 intervals matching the 3 values
- Oversized priority-2 bucket must then split on dim 1 (slug)
- Tests cross-type dimension interaction

**Key assertions:**
- All three priorities are represented in chunks
- Priority 2 chunks are split on the slug dimension
- Full row coverage
- No chunks span multiple priority values (each chunk's dim 0 range should be tight)
