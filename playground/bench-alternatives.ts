/**
 * Benchmark: Alternative approaches not currently in the codebase
 *
 * 1. system.parts_columns min/max metadata (zero scan cost)
 * 2. SAMPLE-based estimation
 * 3. arrayJoin + range to avoid full GROUP BY
 * 4. Approximate count with uniq/uniqCombined
 */
import { query, timed, close, DB, TABLE, PARTITION_ID, strToHex } from './ch-client.ts'

async function main() {
  console.log('=== Alternative Strategies Benchmark ===')
  console.log(`Table: ${DB}.${TABLE}, Partition: ${PARTITION_ID}`)
  console.log()

  // 1. Using system.parts metadata for boundaries (no data scan at all)
  console.log('--- 1. system.parts metadata: rows/bytes per part (zero scan) ---')
  {
    const sql = `
SELECT
  name,
  rows,
  bytes_on_disk,
  marks
FROM system.parts
WHERE database = '${DB}'
  AND table = '${TABLE}'
  AND active = 1
  AND partition_id = '${PARTITION_ID}'
ORDER BY name`

    const [rows, duration] = await timed<{ name: string; rows: number; bytes_on_disk: number; marks: number }>(sql)
    console.log(`  Duration: ${(duration / 1000).toFixed(2)}s`)
    console.log(`  Parts: ${rows.length}`)
    if (rows.length > 0) {
      const totalRows = rows.reduce((sum, r) => sum + Number(r.rows), 0)
      const totalBytes = rows.reduce((sum, r) => sum + Number(r.bytes_on_disk), 0)
      console.log(`  Total rows across parts: ${totalRows.toLocaleString()}`)
      console.log(`  Total bytes: ${(totalBytes / 1e9).toFixed(2)}GB`)
    }
  }

  // 2. SAMPLE-based count estimation
  console.log('\n--- 2. SAMPLE 0.01 (1% sample) for quick row estimation ---')
  {
    const sql = `
SELECT count() * 100 AS estimated_cnt
FROM ${DB}.${TABLE} SAMPLE 0.01
WHERE _partition_id = '${PARTITION_ID}'`

    try {
      const [rows, duration] = await timed<{ estimated_cnt: string }>(sql)
      console.log(`  Duration: ${(duration / 1000).toFixed(2)}s`)
      console.log(`  Estimated rows: ${Number(rows[0]?.estimated_cnt ?? 0).toLocaleString()}`)
    } catch (err: any) {
      console.log(`  FAILED: ${err.message?.slice(0, 200)}`)
    }
  }

  // 3. SAMPLE-based prefix distribution
  console.log('\n--- 3. SAMPLE 0.01 prefix distribution (depth=1) ---')
  {
    const sql = `
SELECT
  substring(contract_address, 1, 1) AS prefix,
  count() * 100 AS estimated_cnt
FROM ${DB}.${TABLE} SAMPLE 0.01
WHERE _partition_id = '${PARTITION_ID}'
GROUP BY prefix
ORDER BY prefix`

    try {
      const [rows, duration] = await timed<{ prefix: string; estimated_cnt: string }>(sql)
      console.log(`  Duration: ${(duration / 1000).toFixed(2)}s`)
      console.log(`  Buckets: ${rows.length}`)
      const totalRows = rows.reduce((sum, r) => sum + Number(r.estimated_cnt), 0)
      console.log(`  Total estimated rows: ${totalRows.toLocaleString()}`)
    } catch (err: any) {
      console.log(`  FAILED: ${err.message?.slice(0, 200)}`)
    }
  }

  // 4. Pre-computed hex prefix ranges using EXPLAIN ESTIMATE (no scan)
  console.log('\n--- 4. Pre-computed 256-way split using EXPLAIN ESTIMATE ---')
  {
    const start = performance.now()
    let totalEstimated = 0
    let bucketCount = 0

    // Split by first byte (256 ranges)
    for (let b = 0; b < 256; b++) {
      const fromByte = Buffer.from([b]).toString('hex')
      const toByte = b < 255 ? Buffer.from([b + 1]).toString('hex') : ''
      const toClause = toByte ? ` AND contract_address < unhex('${toByte}${'00'.repeat(7)}')` : ''
      const sql = `EXPLAIN ESTIMATE SELECT count() FROM ${DB}.${TABLE} WHERE _partition_id = '${PARTITION_ID}' AND contract_address >= unhex('${fromByte}${'00'.repeat(7)}')${toClause}`

      const [rows] = await timed<{ rows: number }>(sql)
      const est = rows[0]?.rows ?? 0
      if (est > 0) bucketCount++
      totalEstimated += est
    }

    const totalDuration = performance.now() - start
    console.log(`  Duration: ${(totalDuration / 1000).toFixed(2)}s (256 queries)`)
    console.log(`  Non-empty buckets: ${bucketCount}`)
    console.log(`  Total estimated rows: ${totalEstimated.toLocaleString()}`)
  }

  // 5. system.parts_columns mark-level metadata
  console.log('\n--- 5. Mark count per part for the partition ---')
  {
    const sql = `
SELECT
  count() AS part_count,
  sum(marks) AS total_marks,
  sum(rows) AS total_rows,
  sum(bytes_on_disk) AS total_bytes
FROM system.parts
WHERE database = '${DB}'
  AND table = '${TABLE}'
  AND active = 1
  AND partition_id = '${PARTITION_ID}'`

    const [rows, duration] = await timed<{ part_count: number; total_marks: number; total_rows: number; total_bytes: number }>(sql)
    console.log(`  Duration: ${(duration / 1000).toFixed(2)}s`)
    if (rows[0]) {
      console.log(`  Parts: ${rows[0].part_count}`)
      console.log(`  Marks: ${Number(rows[0].total_marks).toLocaleString()}`)
      console.log(`  Rows: ${Number(rows[0].total_rows).toLocaleString()}`)
      console.log(`  Bytes: ${(Number(rows[0].total_bytes) / 1e9).toFixed(2)}GB`)
      console.log(`  Rows per mark: ~${Math.round(Number(rows[0].total_rows) / Number(rows[0].total_marks))}`)
    }
  }

  await close()
}

main().catch((err) => { console.error(err); process.exit(1) })
