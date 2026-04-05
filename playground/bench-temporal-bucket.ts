/**
 * Benchmark: Temporal Bucket Split Strategy
 *
 * Groups by toStartOfDay/toStartOfHour on block_timestamp (2nd sort key).
 * This is used when the datetime dimension is available.
 * Since block_timestamp is the partition key (toYYYYMM), partition 202010
 * covers Oct 2020 — so day buckets give ~31 groups, hour buckets ~744.
 */
import { timed, close, DB, TABLE, PARTITION_ID } from './ch-client.ts'

async function main() {
  console.log('=== Temporal Bucket Split Strategy Benchmark ===')
  console.log(`Table: ${DB}.${TABLE}, Partition: ${PARTITION_ID}`)
  console.log()

  // Day-level grouping (what the strategy does first)
  console.log('--- Day-level bucket (GROUP BY toStartOfDay) over full partition ---')
  {
    const sql = `
SELECT
  formatDateTime(toStartOfDay(block_timestamp), '%Y-%m-%dT%H:%i:%sZ') AS bucket,
  count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
GROUP BY bucket
ORDER BY bucket`

    const [rows, duration] = await timed<{ bucket: string; cnt: string }>(sql)
    console.log(`  Duration: ${(duration / 1000).toFixed(2)}s`)
    console.log(`  Buckets: ${rows.length}`)
    const totalRows = rows.reduce((sum, r) => sum + Number(r.cnt), 0)
    console.log(`  Total rows: ${totalRows.toLocaleString()}`)
    if (rows.length > 0) {
      const maxBucket = rows.reduce((max, r) => Number(r.cnt) > Number(max.cnt) ? r : max, rows[0]!)
      console.log(`  Largest day: ${maxBucket.bucket} with ${Number(maxBucket.cnt).toLocaleString()} rows`)
      const minBucket = rows.reduce((min, r) => Number(r.cnt) < Number(min.cnt) ? r : min, rows[0]!)
      console.log(`  Smallest day: ${minBucket.bucket} with ${Number(minBucket.cnt).toLocaleString()} rows`)
    }
  }

  // Hour-level grouping
  console.log('\n--- Hour-level bucket (GROUP BY toStartOfHour) over full partition ---')
  {
    const sql = `
SELECT
  formatDateTime(toStartOfHour(block_timestamp), '%Y-%m-%dT%H:%i:%sZ') AS bucket,
  count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
GROUP BY bucket
ORDER BY bucket`

    const [rows, duration] = await timed<{ bucket: string; cnt: string }>(sql)
    console.log(`  Duration: ${(duration / 1000).toFixed(2)}s`)
    console.log(`  Buckets: ${rows.length}`)
    const totalRows = rows.reduce((sum, r) => sum + Number(r.cnt), 0)
    console.log(`  Total rows: ${totalRows.toLocaleString()}`)
    if (rows.length > 0) {
      const maxBucket = rows.reduce((max, r) => Number(r.cnt) > Number(max.cnt) ? r : max, rows[0]!)
      console.log(`  Largest hour: ${maxBucket.bucket} with ${Number(maxBucket.cnt).toLocaleString()} rows`)
    }
  }

  // Day-level with a sub-range on contract_address
  console.log('\n--- Day-level bucket with range filter (contract_address >= unhex("2d")) ---')
  {
    const sql = `
SELECT
  formatDateTime(toStartOfDay(block_timestamp), '%Y-%m-%dT%H:%i:%sZ') AS bucket,
  count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
  AND contract_address >= unhex('2d')
GROUP BY bucket
ORDER BY bucket`

    const [rows, duration] = await timed<{ bucket: string; cnt: string }>(sql)
    console.log(`  Duration: ${(duration / 1000).toFixed(2)}s`)
    console.log(`  Buckets: ${rows.length}`)
    const totalRows = rows.reduce((sum, r) => sum + Number(r.cnt), 0)
    console.log(`  Total rows: ${totalRows.toLocaleString()}`)
  }

  await close()
}

main().catch((err) => { console.error(err); process.exit(1) })
