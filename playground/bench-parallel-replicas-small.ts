/**
 * Quick test: GROUP BY substring on a small slice, with vs without parallel replicas.
 */
import { close, DB, TABLE, PARTITION_ID, timed } from './ch-client.js'

// Slice 22 range (~21M rows without replicas)
const SLICE_FROM = '427ebe02dc1b56c7'
const SLICE_TO = '4378ddebb790f1ff'

const sql = `SELECT
  substring(contract_address, 1, 2) AS prefix,
  count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
  AND contract_address >= unhex('${SLICE_FROM}')
  AND contract_address < unhex('${SLICE_TO}')
GROUP BY prefix
ORDER BY prefix`

async function run() {
  console.log('--- GROUP BY substring depth=2 on slice 22 (~21M rows) ---\n')

  const [off, msOff] = await timed<{ prefix: string; cnt: string }>(
    `${sql}\nSETTINGS enable_parallel_replicas=0`
  )
  console.log(`replicas=OFF: ${off.length} groups, sum=${off.reduce((a, r) => a + Number(r.cnt), 0).toLocaleString()} (${(msOff / 1000).toFixed(2)}s)`)
  for (const r of off.slice(0, 5)) console.log(`  ${r.prefix}: ${Number(r.cnt).toLocaleString()}`)

  const [on, msOn] = await timed<{ prefix: string; cnt: string }>(sql)
  console.log(`replicas=ON:  ${on.length} groups, sum=${on.reduce((a, r) => a + Number(r.cnt), 0).toLocaleString()} (${(msOn / 1000).toFixed(2)}s)`)
  for (const r of on.slice(0, 5)) console.log(`  ${r.prefix}: ${Number(r.cnt).toLocaleString()}`)

  const ratio = on.reduce((a, r) => a + Number(r.cnt), 0) / off.reduce((a, r) => a + Number(r.cnt), 0)
  console.log(`\nratio: ${ratio.toFixed(2)}x`)

  await close()
}

run().catch((err) => { console.error(err); process.exit(1) })
