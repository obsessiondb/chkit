/**
 * Benchmark: String Prefix Split Strategy
 *
 * This is what the current code does - GROUP BY substring(contract_address, 1, N)
 * at increasing depths (1-4). This is the query that was running for 7000+ seconds.
 *
 * We test each depth level independently to see where the bottleneck is.
 */
import { query, timed, close, DB, TABLE, PARTITION_ID, elapsed } from './ch-client.ts'

const WHERE = `_partition_id = '${PARTITION_ID}'`

async function main() {
  console.log('=== String Prefix Split Strategy Benchmark ===')
  console.log(`Table: ${DB}.${TABLE}, Partition: ${PARTITION_ID}`)
  console.log()

  // Depth 1: full partition (this is the slow query from the logs)
  for (const depth of [1, 2, 3, 4]) {
    const sql = `
SELECT
  substring(contract_address, 1, ${depth}) AS prefix,
  count() AS cnt
FROM ${DB}.${TABLE}
WHERE ${WHERE}
GROUP BY prefix
ORDER BY prefix`

    console.log(`--- Depth ${depth}: GROUP BY substring(contract_address, 1, ${depth}) over full partition ---`)
    console.log(`SQL: ${sql.trim().slice(0, 200)}...`)

    const start = performance.now()
    try {
      const [rows, duration] = await timed<{ prefix: string; cnt: string }>(sql)
      console.log(`  Duration: ${(duration / 1000).toFixed(2)}s`)
      console.log(`  Buckets: ${rows.length}`)
      const totalRows = rows.reduce((sum, r) => sum + Number(r.cnt), 0)
      console.log(`  Total rows: ${totalRows.toLocaleString()}`)
      if (rows.length > 0) {
        const maxBucket = rows.reduce((max, r) => Number(r.cnt) > Number(max.cnt) ? r : max, rows[0]!)
        console.log(`  Largest bucket: prefix="${Buffer.from(maxBucket.prefix, 'latin1').toString('hex')}" rows=${Number(maxBucket.cnt).toLocaleString()}`)
      }
    } catch (err: any) {
      console.log(`  FAILED after ${elapsed(start)}: ${err.message?.slice(0, 200)}`)
    }
    console.log()
  }

  // Now test with the sub-range from the slow query (contract_address >= unhex('2d'))
  console.log('--- Depth 1 with range filter (contract_address >= unhex("2d")) ---')
  {
    const sql = `
SELECT
  substring(contract_address, 1, 1) AS prefix,
  count() AS cnt
FROM ${DB}.${TABLE}
WHERE ${WHERE}
  AND contract_address >= unhex('2d')
GROUP BY prefix
ORDER BY prefix`

    const start = performance.now()
    try {
      const [rows, duration] = await timed<{ prefix: string; cnt: string }>(sql)
      console.log(`  Duration: ${(duration / 1000).toFixed(2)}s`)
      console.log(`  Buckets: ${rows.length}`)
      const totalRows = rows.reduce((sum, r) => sum + Number(r.cnt), 0)
      console.log(`  Total rows: ${totalRows.toLocaleString()}`)
    } catch (err: any) {
      console.log(`  FAILED after ${elapsed(start)}: ${err.message?.slice(0, 200)}`)
    }
  }

  await close()
}

main().catch((err) => { console.error(err); process.exit(1) })
