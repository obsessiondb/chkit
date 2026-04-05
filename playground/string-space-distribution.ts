/**
 * String Space Distribution — First Sort Key
 *
 * For partition 202010 of solana_transfers:
 *   1. Fetch min/max of contract_address (first sort key)
 *   2. Mathematically split the string space into N equal-width sub-ranges
 *   3. Print the boundaries — no counts, no scanning, just the guess
 *
 * Usage: bun run playground/string-space-distribution.ts [numSlices]
 */
import { query, close, DB, TABLE, PARTITION_ID, strToHex, elapsed } from './ch-client.js'

const NUM_SLICES = Number(process.argv[2]) || 16

// --- String ↔ BigInt helpers (from chunking/utils/binary-string.ts) ---

function strToBigInt(value: string, padTo: number): bigint {
  const buffer = Buffer.from(value, 'latin1')
  let result = 0n
  for (let index = 0; index < padTo; index++) {
    const byte = index < buffer.length ? (buffer[index] ?? 0) : 0
    result = (result << 8n) | BigInt(byte)
  }
  return result
}

function bigIntToStr(value: bigint, length: number): string {
  const buffer = Buffer.alloc(length)
  let remaining = value
  for (let index = length - 1; index >= 0; index--) {
    buffer[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return buffer.toString('latin1')
}

function printable(value: string): string {
  // Show first 40 chars, replacing non-printable with dots
  return value.slice(0, 40).replace(/[^\x20-\x7E]/g, '.')
}

// --- Main ---

async function main() {
  console.log(`\n=== String Space Distribution ===`)
  console.log(`Table: ${DB}.${TABLE}`)
  console.log(`Partition: ${PARTITION_ID}`)
  console.log(`Slices: ${NUM_SLICES}`)
  console.log()

  // Step 1: Get min/max of contract_address in the partition
  // Cached from previous run to avoid 535M-row scan (~0.2s best case, flaky under load)
  const CACHED_MIN_HEX = '2d' // "-"
  const CACHED_MAX_HEX = '764759384b74794c5a6545635a6676743370763532614453564c3157654e32647a38356834356e6142544c'
  // "vGY8KtyLZeEcZfvt3pv52aDSVL1WeN2dz85h45naBTL"

  let minVal: string
  let maxVal: string
  const start = performance.now()

  if (process.argv.includes('--no-cache')) {
    const minMax = await query<{ minVal: string; maxVal: string }>(`
      SELECT
        min(contract_address) AS minVal,
        max(contract_address) AS maxVal
      FROM ${DB}.${TABLE}
      WHERE _partition_id = '${PARTITION_ID}'
    `)
    minVal = minMax[0]?.minVal ?? ''
    maxVal = minMax[0]?.maxVal ?? ''
    console.log(`Min/Max query took: ${elapsed(start)}`)
  } else {
    minVal = Buffer.from(CACHED_MIN_HEX, 'hex').toString('latin1')
    maxVal = Buffer.from(CACHED_MAX_HEX, 'hex').toString('latin1')
    console.log(`Min/Max from cache (use --no-cache to re-query)`)
  }
  console.log(`Min: ${strToHex(minVal)} → "${printable(minVal)}"`)
  console.log(`Max: ${strToHex(maxVal)} → "${printable(maxVal)}"`)

  // Convert to bigint space (8 bytes = 64 bits of string space)
  const PAD = 8
  const minBig = strToBigInt(minVal, PAD)
  const maxBig = strToBigInt(maxVal + '\0', PAD) // exclusive upper bound

  console.log(`\nBigInt range: ${minBig} → ${maxBig}`)
  console.log(`Range width:  ${maxBig - minBig}`)
  console.log()

  // Step 2: Build equal-width boundaries
  const boundaries: { from: string; to: string; fromHex: string; toHex: string }[] = []
  for (let i = 0; i < NUM_SLICES; i++) {
    const fromBig = minBig + ((maxBig - minBig) * BigInt(i)) / BigInt(NUM_SLICES)
    const toBig = minBig + ((maxBig - minBig) * BigInt(i + 1)) / BigInt(NUM_SLICES)
    const fromStr = bigIntToStr(fromBig, PAD)
    const toStr = bigIntToStr(toBig, PAD)
    boundaries.push({
      from: fromStr,
      to: toStr,
      fromHex: strToHex(fromStr),
      toHex: strToHex(toStr),
    })
  }

  // Step 3: Print the distribution
  console.log(`=== Equal-Width String Space Boundaries (${NUM_SLICES} slices) ===\n`)
  console.log(`${'#'.padStart(3)} | ${'From (hex)'.padEnd(20)} | ${'To (hex)'.padEnd(20)} | From (printable)`)
  console.log(`${''.padStart(3, '-')} | ${''.padStart(20, '-')} | ${''.padStart(20, '-')} | ${''.padStart(40, '-')}`)

  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!
    console.log(
      `${String(i + 1).padStart(3)} | ${b.fromHex.slice(0, 20).padEnd(20)} | ${b.toHex.slice(0, 20).padEnd(20)} | ${printable(b.from)}`
    )
  }

  // Step 4: Show where "interesting" prefixes fall
  console.log(`\n=== Where common prefixes would land ===\n`)
  const samplePrefixes = ['0', '1', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'S', 'T', 'a', 'z']
  for (const prefix of samplePrefixes) {
    const prefixBig = strToBigInt(prefix, PAD)
    if (prefixBig < minBig || prefixBig > maxBig) {
      console.log(`  "${prefix}" (0x${strToHex(prefix).padEnd(4)}) → outside range`)
      continue
    }
    const sliceIndex = Number(((prefixBig - minBig) * BigInt(NUM_SLICES)) / (maxBig - minBig))
    console.log(`  "${prefix}" (0x${strToHex(prefix).padEnd(4)}) → slice ${sliceIndex + 1}/${NUM_SLICES}`)
  }

  // Step 5: Now optionally get the EXPLAIN ESTIMATE row counts for each slice
  // This is fast (~0.08s per query) and gives us the actual distribution
  console.log(`\n=== EXPLAIN ESTIMATE row distribution (fast, metadata-only) ===\n`)
  const estimateStart = performance.now()
  const estimates: { slice: number; rows: number; from: string; to: string }[] = []

  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!
    const result = await query<Record<string, string | number | undefined>>(`
      EXPLAIN ESTIMATE
      SELECT 1
      FROM ${DB}.${TABLE}
      WHERE _partition_id = '${PARTITION_ID}'
        AND contract_address >= unhex('${b.fromHex}')
        AND contract_address < unhex('${b.toHex}')
    `)

    let rows = 0
    const firstRow = result[0]
    if (firstRow) {
      for (const [key, value] of Object.entries(firstRow)) {
        if (key.toLowerCase().includes('row')) {
          rows = Number(value ?? 0)
          break
        }
      }
    }
    estimates.push({ slice: i + 1, rows, from: b.fromHex, to: b.toHex })
  }

  console.log(`All EXPLAIN ESTIMATE queries took: ${elapsed(estimateStart)}`)
  console.log()

  const totalEstimatedRows = estimates.reduce((sum, e) => sum + e.rows, 0)
  const maxRows = Math.max(...estimates.map((e) => e.rows))

  console.log(`${'#'.padStart(3)} | ${'Est. Rows'.padStart(14)} | ${'%'.padStart(6)} | Bar`)
  console.log(`${''.padStart(3, '-')} | ${''.padStart(14, '-')} | ${''.padStart(6, '-')} | ${''.padStart(50, '-')}`)

  for (const e of estimates) {
    const pct = totalEstimatedRows > 0 ? (e.rows / totalEstimatedRows * 100) : 0
    const barWidth = maxRows > 0 ? Math.round((e.rows / maxRows) * 50) : 0
    const bar = '#'.repeat(barWidth)
    console.log(
      `${String(e.slice).padStart(3)} | ${e.rows.toLocaleString().padStart(14)} | ${pct.toFixed(1).padStart(5)}% | ${bar}`
    )
  }

  console.log(`\nTotal estimated rows: ${totalEstimatedRows.toLocaleString()}`)
  console.log(`Actual rows (from system.parts): 535,310,542`)

  // Summary
  const nonEmpty = estimates.filter((e) => e.rows > 0)
  const emptySlices = estimates.filter((e) => e.rows === 0)
  console.log(`\nNon-empty slices: ${nonEmpty.length}/${NUM_SLICES}`)
  console.log(`Empty slices: ${emptySlices.length}/${NUM_SLICES}`)

  if (nonEmpty.length > 0) {
    const avgRows = totalEstimatedRows / nonEmpty.length
    const maxSkew = Math.max(...nonEmpty.map((e) => e.rows)) / avgRows
    console.log(`Avg rows per non-empty slice: ${Math.round(avgRows).toLocaleString()}`)
    console.log(`Max skew factor: ${maxSkew.toFixed(1)}x (${maxSkew > 3 ? 'SKEWED — data is clustered, not uniform' : 'reasonable'})`)
  }

  await close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
