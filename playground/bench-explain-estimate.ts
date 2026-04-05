/**
 * Benchmark: EXPLAIN ESTIMATE strategy (used by quantile + equal-width splits)
 *
 * Instead of doing exact counts or GROUP BY, this uses EXPLAIN ESTIMATE
 * which reads part metadata without scanning data. Much faster but approximate.
 *
 * We simulate: splitting the range into N equal-width sub-ranges and estimating each.
 */
import { query, timed, close, DB, TABLE, PARTITION_ID, strToHex } from './ch-client.ts'

function bigIntToStr(n: bigint, len: number): string {
  const bytes = new Uint8Array(len)
  let val = n
  for (let i = len - 1; i >= 0; i--) {
    bytes[i] = Number(val & 0xffn)
    val >>= 8n
  }
  return Buffer.from(bytes).toString('latin1')
}

function strToBigInt(s: string, len: number): bigint {
  const buf = Buffer.from(s, 'latin1')
  let result = 0n
  for (let i = 0; i < len; i++) {
    result = (result << 8n) | BigInt(buf[i] ?? 0)
  }
  return result
}

async function main() {
  console.log('=== EXPLAIN ESTIMATE Strategy Benchmark ===')
  console.log(`Table: ${DB}.${TABLE}, Partition: ${PARTITION_ID}`)
  console.log()

  // First, get a rough idea of the range via EXPLAIN ESTIMATE on the whole partition
  const fullEstimate = await query<{ rows: number; marks: number }>(
    `EXPLAIN ESTIMATE SELECT count() FROM ${DB}.${TABLE} WHERE _partition_id = '${PARTITION_ID}'`
  )
  console.log('Full partition estimate:', fullEstimate[0])

  // Simulate equal-width splitting: divide byte range into N sub-ranges
  // Use the full byte range (0x00 to 0xFF for first byte)
  // We'll use 8-byte BigInt representation like the actual code
  const SUB_COUNTS = [4, 8, 16, 32]
  const rangeFromBig = 0n
  const rangeToBig = (1n << 64n) - 1n // full 8-byte range

  for (const subCount of SUB_COUNTS) {
    console.log(`\n--- Equal-width ${subCount} sub-ranges using EXPLAIN ESTIMATE ---`)
    const totalStart = performance.now()
    let totalEstimatedRows = 0

    for (let i = 0; i < subCount; i++) {
      const from = rangeFromBig + ((rangeToBig - rangeFromBig) * BigInt(i)) / BigInt(subCount)
      const to = rangeFromBig + ((rangeToBig - rangeFromBig) * BigInt(i + 1)) / BigInt(subCount)
      const fromStr = bigIntToStr(from, 8)
      const toStr = bigIntToStr(to, 8)
      const fromHex = strToHex(fromStr)
      const toHex = strToHex(toStr)

      const sql = `EXPLAIN ESTIMATE SELECT count() FROM ${DB}.${TABLE} WHERE _partition_id = '${PARTITION_ID}' AND contract_address >= unhex('${fromHex}') AND contract_address < unhex('${toHex}')`

      const [rows] = await timed<{ rows: number }>(sql)
      totalEstimatedRows += rows[0]?.rows ?? 0
    }

    const totalDuration = performance.now() - totalStart
    console.log(`  Duration: ${(totalDuration / 1000).toFixed(2)}s (${subCount} queries)`)
    console.log(`  Avg per query: ${(totalDuration / subCount / 1000).toFixed(3)}s`)
    console.log(`  Total estimated rows: ${totalEstimatedRows.toLocaleString()}`)
  }

  // Now simulate what quantile binary search does: 24 binary search steps
  console.log('\n--- Quantile Binary Search (24 steps) using EXPLAIN ESTIMATE ---')
  {
    const totalStart = performance.now()
    let queryCount = 0

    // Target: find the midpoint that splits rows roughly in half
    let low = rangeFromBig
    let high = rangeToBig

    for (let step = 0; step < 24; step++) {
      const mid = (low + high) / 2n
      if (mid === low || mid === high) break
      const midStr = bigIntToStr(mid, 8)
      const midHex = strToHex(midStr)
      const fromHex = strToHex(bigIntToStr(rangeFromBig, 8))

      const sql = `EXPLAIN ESTIMATE SELECT count() FROM ${DB}.${TABLE} WHERE _partition_id = '${PARTITION_ID}' AND contract_address >= unhex('${fromHex}') AND contract_address < unhex('${midHex}')`

      const [rows] = await timed<{ rows: number }>(sql)
      queryCount++
      const estimated = rows[0]?.rows ?? 0
      // Target ~267M (half of 535M)
      if (estimated < 267_000_000) low = mid
      else high = mid
    }

    const totalDuration = performance.now() - totalStart
    console.log(`  Duration: ${(totalDuration / 1000).toFixed(2)}s (${queryCount} queries)`)
    console.log(`  Avg per query: ${(totalDuration / queryCount / 1000).toFixed(3)}s`)
  }

  // Compare: quantile binary search using exact COUNT instead of EXPLAIN ESTIMATE
  console.log('\n--- Quantile Binary Search (24 steps) using exact COUNT ---')
  {
    const totalStart = performance.now()
    let queryCount = 0
    let low = rangeFromBig
    let high = rangeToBig

    for (let step = 0; step < 24; step++) {
      const mid = (low + high) / 2n
      if (mid === low || mid === high) break
      const midStr = bigIntToStr(mid, 8)
      const midHex = strToHex(midStr)
      const fromHex = strToHex(bigIntToStr(rangeFromBig, 8))

      const sql = `SELECT count() AS cnt FROM ${DB}.${TABLE} WHERE _partition_id = '${PARTITION_ID}' AND contract_address >= unhex('${fromHex}') AND contract_address < unhex('${midHex}')`

      const [rows] = await timed<{ cnt: string }>(sql)
      queryCount++
      const counted = Number(rows[0]?.cnt ?? 0)
      if (counted < 267_000_000) low = mid
      else high = mid
    }

    const totalDuration = performance.now() - totalStart
    console.log(`  Duration: ${(totalDuration / 1000).toFixed(2)}s (${queryCount} queries)`)
    console.log(`  Avg per query: ${(totalDuration / queryCount / 1000).toFixed(3)}s`)
  }

  await close()
}

main().catch((err) => { console.error(err); process.exit(1) })
