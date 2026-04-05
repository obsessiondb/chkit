/**
 * Compare two first-pass strategies on partition 202010:
 *
 * A) Current: string prefix GROUP BY (GROUP BY substring(key, 1, depth))
 *    - recursive depth 1→4 for oversized prefixes
 *
 * B) Analysis recommendation: equal-width EXPLAIN ESTIMATE
 *    - split key space into subCount*3 ranges, EXPLAIN ESTIMATE each
 *    - for oversized slices: GROUP BY key1 within slice range
 */
import { close, DB, TABLE, PARTITION_ID, timed, formatBound, elapsed } from './ch-client.js'

const TARGET_CHUNK_BYTES_UNCOMPRESSED = 10n * 1024n * 1024n * 1024n // 10 GB
const PARTITION_BYTES_UNCOMPRESSED = 149_838_775_785n
const PARTITION_ROWS = 535_310_542
const SUB_COUNT = Number(PARTITION_BYTES_UNCOMPRESSED / TARGET_CHUNK_BYTES_UNCOMPRESSED) + 1 // 15
const OVERSAMPLING = 3

// ─── Helpers ────────────────────────────────────────────────────────

function strToBigInt(s: string): bigint {
  const buf = Buffer.from(s, 'latin1')
  let n = 0n
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(buf[i] ?? 0)
  return n
}

function bigIntToStr(n: bigint): string {
  const bytes = new Uint8Array(8)
  for (let i = 7; i >= 0; i--) { bytes[i] = Number(n & 0xffn); n >>= 8n }
  return Buffer.from(bytes).toString('latin1')
}

function strToHex(s: string): string {
  return Buffer.from(s, 'latin1').toString('hex')
}

interface TimedResult { queries: number; totalMs: number }
interface SliceResult { from: string; to: string; rows: number; label?: string }

// ─── Strategy A: String Prefix GROUP BY ─────────────────────────────

async function strategyA(): Promise<{ timing: TimedResult; slices: SliceResult[] }> {
  const start = performance.now()
  let queries = 0

  // Step 1: min/max
  const [minmax] = await timed<{ minVal: string; maxVal: string }>(`
SELECT toString(min(contract_address)) AS minVal, toString(max(contract_address)) AS maxVal
FROM ${DB}.${TABLE} WHERE _partition_id = '${PARTITION_ID}'
SETTINGS enable_parallel_replicas=0`)
  queries++
  const minVal = minmax[0]!.minVal
  const maxVal = minmax[0]!.maxVal
  console.log(`  [A] min/max: ${strToHex(minVal).slice(0,16)}..${strToHex(maxVal).slice(0,16)} (${elapsed(start)})`)

  // Step 2: GROUP BY substring depth=1
  const [depth1] = await timed<{ prefix: string; cnt: string }>(`
SELECT substring(contract_address, 1, 1) AS prefix, count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
  AND contract_address >= ${formatBound(minVal)}
  AND contract_address < ${formatBound(maxVal + '\0')}
GROUP BY prefix ORDER BY prefix
SETTINGS enable_parallel_replicas=0`)
  queries++
  console.log(`  [A] depth=1 prefixes: ${depth1.length} groups (${elapsed(start)})`)

  const targetRows = (Number(TARGET_CHUNK_BYTES_UNCOMPRESSED) * PARTITION_ROWS) / Number(PARTITION_BYTES_UNCOMPRESSED)
  const oversizedPrefixes = depth1.filter(r => Number(r.cnt) > targetRows * 1.15)
  console.log(`  [A] oversized depth=1 prefixes: ${oversizedPrefixes.length} (target rows: ${Math.round(targetRows).toLocaleString()})`)

  // Step 3: drill deeper on oversized prefixes
  const allSlices: SliceResult[] = []

  for (const bucket of depth1) {
    const rows = Number(bucket.cnt)
    if (rows <= 0) continue

    if (rows <= targetRows * 1.15) {
      // Small enough — keep as-is
      allSlices.push({ from: bucket.prefix, to: bucket.prefix + '\xff', rows, label: `prefix=${strToHex(bucket.prefix)}` })
      continue
    }

    // Drill to depth 2
    const [depth2] = await timed<{ prefix: string; cnt: string }>(`
SELECT substring(contract_address, 1, 2) AS prefix, count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
  AND contract_address >= ${formatBound(bucket.prefix)}
  AND contract_address < ${formatBound(bucket.prefix + '\xff')}
GROUP BY prefix ORDER BY prefix
SETTINGS enable_parallel_replicas=0`)
    queries++

    for (const sub of depth2) {
      const subRows = Number(sub.cnt)
      if (subRows <= 0) continue

      if (subRows <= targetRows * 1.15) {
        allSlices.push({ from: sub.prefix, to: sub.prefix + '\xff', rows: subRows, label: `prefix=${strToHex(sub.prefix)}` })
        continue
      }

      // Drill to depth 3
      const [depth3] = await timed<{ prefix: string; cnt: string }>(`
SELECT substring(contract_address, 1, 3) AS prefix, count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
  AND contract_address >= ${formatBound(sub.prefix)}
  AND contract_address < ${formatBound(sub.prefix + '\xff')}
GROUP BY prefix ORDER BY prefix
SETTINGS enable_parallel_replicas=0`)
      queries++

      for (const sub3 of depth3) {
        allSlices.push({ from: sub3.prefix, to: sub3.prefix + '\xff', rows: Number(sub3.cnt), label: `prefix=${strToHex(sub3.prefix)}` })
      }
    }
  }

  const totalMs = performance.now() - start
  return { timing: { queries, totalMs }, slices: allSlices }
}

// ─── Strategy B: Equal-Width EXPLAIN ESTIMATE ───────────────────────

async function strategyB(): Promise<{ timing: TimedResult; slices: SliceResult[] }> {
  const start = performance.now()
  let queries = 0

  // Step 1: min/max
  const [minmax] = await timed<{ minVal: string; maxVal: string }>(`
SELECT toString(min(contract_address)) AS minVal, toString(max(contract_address)) AS maxVal
FROM ${DB}.${TABLE} WHERE _partition_id = '${PARTITION_ID}'
SETTINGS enable_parallel_replicas=0`)
  queries++
  const minVal = minmax[0]!.minVal
  const maxVal = minmax[0]!.maxVal + '\0' // exclusive upper
  console.log(`  [B] min/max: ${strToHex(minVal).slice(0,16)}..${strToHex(maxVal).slice(0,16)} (${elapsed(start)})`)

  // Step 2: equal-width EXPLAIN ESTIMATE
  const rangeCount = SUB_COUNT * OVERSAMPLING // 45
  const minBig = strToBigInt(minVal)
  const maxBig = strToBigInt(maxVal)
  const step = (maxBig - minBig) / BigInt(rangeCount)

  const boundaries: string[] = []
  for (let i = 0; i <= rangeCount; i++) {
    boundaries.push(bigIntToStr(minBig + step * BigInt(i)))
  }
  boundaries[boundaries.length - 1] = maxVal // ensure last boundary is maxVal

  const estimateSlices: SliceResult[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = boundaries[i]!
    const to = boundaries[i + 1]!
    const [rows] = await timed<Record<string, string>>(`
EXPLAIN ESTIMATE SELECT 1 FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
  AND contract_address >= ${formatBound(from)}
  AND contract_address < ${formatBound(to)}`)
    queries++

    // Parse EXPLAIN ESTIMATE result
    const firstRow = rows[0]
    let rowCount = 0
    if (firstRow) {
      for (const [key, value] of Object.entries(firstRow)) {
        if (key.toLowerCase().includes('row')) { rowCount = Number(value ?? 0); break }
      }
      if (rowCount === 0) {
        for (const value of Object.values(firstRow)) {
          const n = Number(value ?? 0)
          if (Number.isFinite(n) && n > 0) { rowCount = n; break }
        }
      }
    }

    estimateSlices.push({ from, to, rows: rowCount, label: `${strToHex(from).slice(0,4)}..${strToHex(to).slice(0,4)}` })
  }

  console.log(`  [B] ${rangeCount} EXPLAIN ESTIMATE queries done (${elapsed(start)})`)

  const targetRows = (Number(TARGET_CHUNK_BYTES_UNCOMPRESSED) * PARTITION_ROWS) / Number(PARTITION_BYTES_UNCOMPRESSED)
  const oversized = estimateSlices.filter(s => s.rows > targetRows * 1.15)
  console.log(`  [B] oversized slices: ${oversized.length} of ${estimateSlices.length} (target rows: ${Math.round(targetRows).toLocaleString()})`)

  // Step 3: GROUP BY for oversized slices
  const finalSlices: SliceResult[] = []
  for (const slice of estimateSlices) {
    if (slice.rows <= targetRows * 1.15) {
      finalSlices.push(slice)
      continue
    }

    // GROUP BY contract_address within this slice
    const [grouped] = await timed<{ key: string; cnt: string }>(`
SELECT contract_address AS key, count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
  AND contract_address >= ${formatBound(slice.from)}
  AND contract_address < ${formatBound(slice.to)}
GROUP BY key ORDER BY cnt DESC
SETTINGS enable_parallel_replicas=0`)
    queries++

    for (const row of grouped) {
      finalSlices.push({
        from: row.key,
        to: row.key + '\0',
        rows: Number(row.cnt),
        label: `key=${strToHex(row.key).slice(0,16)}`,
      })
    }
  }

  console.log(`  [B] GROUP BY refinement done (${elapsed(start)})`)

  const totalMs = performance.now() - start
  return { timing: { queries, totalMs }, slices: finalSlices }
}

// ─── Main ───────────────────────────────────────────────────────────

async function run() {
  console.log(`=== First-Pass Strategy Comparison ===`)
  console.log(`Table: ${DB}.${TABLE}, Partition: ${PARTITION_ID}`)
  console.log(`Target: 10 GB uncompressed, expected ~${SUB_COUNT} chunks\n`)

  console.log('--- Strategy A: String Prefix GROUP BY ---')
  const a = await strategyA()

  console.log('\n--- Strategy B: Equal-Width EXPLAIN ESTIMATE + GROUP BY ---')
  const b = await strategyB()

  console.log('\n=== Results ===\n')

  const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`

  console.log('| Metric | Strategy A (prefix) | Strategy B (explain+groupby) |')
  console.log('|--------|--------------------|-----------------------------|')
  console.log(`| Total time | ${fmt(a.timing.totalMs)} | ${fmt(b.timing.totalMs)} |`)
  console.log(`| Queries | ${a.timing.queries} | ${b.timing.queries} |`)
  console.log(`| Final slices | ${a.slices.length} | ${b.slices.length} |`)
  console.log(`| Total rows | ${a.slices.reduce((s, x) => s + x.rows, 0).toLocaleString()} | ${b.slices.reduce((s, x) => s + x.rows, 0).toLocaleString()} |`)

  const aMax = Math.max(...a.slices.map(s => s.rows))
  const bMax = Math.max(...b.slices.map(s => s.rows))
  console.log(`| Largest slice (rows) | ${aMax.toLocaleString()} | ${bMax.toLocaleString()} |`)

  const aOver = a.slices.filter(s => s.rows > 35_000_000).length
  const bOver = b.slices.filter(s => s.rows > 35_000_000).length
  console.log(`| Slices > 35M rows | ${aOver} | ${bOver} |`)

  // Top 5 slices for each
  console.log('\nTop 5 slices (Strategy A):')
  const aTop = [...a.slices].sort((x, y) => y.rows - x.rows).slice(0, 5)
  for (const s of aTop) console.log(`  ${s.label}: ${s.rows.toLocaleString()} rows`)

  console.log('\nTop 5 slices (Strategy B):')
  const bTop = [...b.slices].sort((x, y) => y.rows - x.rows).slice(0, 5)
  for (const s of bTop) console.log(`  ${s.label}: ${s.rows.toLocaleString()} rows`)

  await close()
}

run().catch((err) => { console.error(err); process.exit(1) })
