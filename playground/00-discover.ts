/**
 * Discover table metadata: sorting key, partition info, and the actual sort key range
 * for the hot partition 202010.
 */
import { query, close, DB, TABLE, PARTITION_ID, strToHex } from './ch-client.ts'

async function main() {
  console.log('=== Table Schema ===')
  const tableInfo = await query<{ sorting_key: string; partition_key: string; engine: string }>(
    `SELECT sorting_key, partition_key, engine FROM system.tables WHERE database = '${DB}' AND name = '${TABLE}'`
  )
  console.log(tableInfo)

  console.log('\n=== Columns (first 20) ===')
  const columns = await query<{ name: string; type: string }>(
    `SELECT name, type FROM system.columns WHERE database = '${DB}' AND table = '${TABLE}' ORDER BY position LIMIT 20`
  )
  console.log(columns)

  console.log('\n=== Partition 202010 metadata ===')
  const parts = await query<{ partition_id: string; total_rows: string; total_bytes: string; total_uncompressed: string }>(
    `SELECT partition_id, toString(sum(rows)) AS total_rows, toString(sum(bytes_on_disk)) AS total_bytes, toString(sum(data_uncompressed_bytes)) AS total_uncompressed FROM system.parts WHERE database = '${DB}' AND table = '${TABLE}' AND active = 1 AND partition_id = '${PARTITION_ID}' GROUP BY partition_id`
  )
  console.log(parts)

  console.log('\n=== Sort key range in partition 202010 ===')
  const range = await query<{ minVal: string; maxVal: string }>(
    `SELECT toString(min(contract_address)) AS minVal, toString(max(contract_address)) AS maxVal FROM ${DB}.${TABLE} WHERE _partition_id = '${PARTITION_ID}'`
  )
  if (range[0]) {
    console.log('min (hex):', strToHex(range[0].minVal), '  length:', range[0].minVal.length)
    console.log('max (hex):', strToHex(range[0].maxVal), '  length:', range[0].maxVal.length)
  }

  console.log('\n=== Sort key range in the HOT sub-range (from unhex(2d)) ===')
  const hotRange = await query<{ minVal: string; maxVal: string; cnt: string }>(
    `SELECT toString(min(contract_address)) AS minVal, toString(max(contract_address)) AS maxVal, toString(count()) AS cnt FROM ${DB}.${TABLE} WHERE _partition_id = '${PARTITION_ID}' AND contract_address >= unhex('2d')`
  )
  if (hotRange[0]) {
    console.log('min (hex):', strToHex(hotRange[0].minVal))
    console.log('max (hex):', strToHex(hotRange[0].maxVal))
    console.log('row count:', hotRange[0].cnt)
  }

  await close()
}

main().catch((err) => { console.error(err); process.exit(1) })
