/**
 * Drill into slice 22 (B prefix, 40.5% of partition)
 * Subdivide into 50 pieces and EXPLAIN ESTIMATE each
 */
import { query, close, DB, TABLE, PARTITION_ID, strToHex, elapsed } from './ch-client.js'

const NUM_SLICES = Number(process.argv[2]) || 50

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
  return value.slice(0, 40).replace(/[^\x20-\x7E]/g, '.')
}

async function main() {
  // Slice 22 exact boundaries from the 75-slice run
  const SLICE_FROM_HEX = '427ebe02dc1b56c7'
  const SLICE_TO_HEX = '4378ddebb790f1ff'

  const fromStr = Buffer.from(SLICE_FROM_HEX, 'hex').toString('latin1')
  const toStr = Buffer.from(SLICE_TO_HEX, 'hex').toString('latin1')

  console.log(`\n=== Slice 22 Drill-Down ===`)
  console.log(`Table: ${DB}.${TABLE}`)
  console.log(`Partition: ${PARTITION_ID}`)
  console.log(`Range: 0x${SLICE_FROM_HEX} → 0x${SLICE_TO_HEX}`)
  console.log(`       "${printable(fromStr)}" → "${printable(toStr)}"`)
  console.log(`Sub-slices: ${NUM_SLICES}`)
  console.log()

  const PAD = 8
  const minBig = strToBigInt(fromStr, PAD)
  const maxBig = strToBigInt(toStr, PAD)

  // Build sub-boundaries
  const estimates: { slice: number; rows: number; fromHex: string; toHex: string; fromPrintable: string }[] = []
  const start = performance.now()

  for (let i = 0; i < NUM_SLICES; i++) {
    const fromBig = minBig + ((maxBig - minBig) * BigInt(i)) / BigInt(NUM_SLICES)
    const toBig = minBig + ((maxBig - minBig) * BigInt(i + 1)) / BigInt(NUM_SLICES)
    const from = bigIntToStr(fromBig, PAD)
    const to = bigIntToStr(toBig, PAD)
    const fHex = strToHex(from)
    const tHex = strToHex(to)

    const result = await query<Record<string, string | number | undefined>>(`
      EXPLAIN ESTIMATE
      SELECT 1
      FROM ${DB}.${TABLE}
      WHERE _partition_id = '${PARTITION_ID}'
        AND contract_address >= unhex('${fHex}')
        AND contract_address < unhex('${tHex}')
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
    estimates.push({ slice: i + 1, rows, fromHex: fHex, toHex: tHex, fromPrintable: printable(from) })
  }

  console.log(`All ${NUM_SLICES} EXPLAIN ESTIMATE queries took: ${elapsed(start)}`)
  console.log()

  const totalEstimatedRows = estimates.reduce((sum, e) => sum + e.rows, 0)
  const maxRows = Math.max(...estimates.map((e) => e.rows))

  console.log(`${'#'.padStart(3)} | ${'Est. Rows'.padStart(14)} | ${'%'.padStart(6)} | ${'From (hex)'.padEnd(18)} | Bar`)
  console.log(`${''.padStart(3, '-')} | ${''.padStart(14, '-')} | ${''.padStart(6, '-')} | ${''.padStart(18, '-')} | ${''.padStart(50, '-')}`)

  for (const e of estimates) {
    const pct = totalEstimatedRows > 0 ? (e.rows / totalEstimatedRows * 100) : 0
    const barWidth = maxRows > 0 ? Math.round((e.rows / maxRows) * 50) : 0
    const bar = '#'.repeat(barWidth)
    console.log(
      `${String(e.slice).padStart(3)} | ${e.rows.toLocaleString().padStart(14)} | ${pct.toFixed(1).padStart(5)}% | ${e.fromHex.slice(0, 18).padEnd(18)} | ${bar}`
    )
  }

  console.log(`\nTotal estimated rows in slice 22: ${totalEstimatedRows.toLocaleString()}`)

  // Top N
  const sorted = [...estimates].sort((a, b) => b.rows - a.rows)
  console.log(`\nTop 10 hottest sub-slices:`)
  for (const e of sorted.slice(0, 10)) {
    const pct = totalEstimatedRows > 0 ? (e.rows / totalEstimatedRows * 100) : 0
    console.log(`  Sub-slice ${String(e.slice).padStart(3)}: ${e.rows.toLocaleString().padStart(14)} rows (${pct.toFixed(1)}%) | 0x${e.fromHex.slice(0, 16)}`)
  }

  const nonEmpty = estimates.filter((e) => e.rows > 0)
  console.log(`\nNon-empty sub-slices: ${nonEmpty.length}/${NUM_SLICES}`)
  if (nonEmpty.length > 0) {
    const avgRows = totalEstimatedRows / nonEmpty.length
    const maxSkew = Math.max(...nonEmpty.map((e) => e.rows)) / avgRows
    console.log(`Avg rows per non-empty sub-slice: ${Math.round(avgRows).toLocaleString()}`)
    console.log(`Max skew factor: ${maxSkew.toFixed(1)}x`)
  }

  await close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
