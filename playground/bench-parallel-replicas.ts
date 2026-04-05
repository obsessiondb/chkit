/**
 * Test whether min(), max(), and GROUP BY queries are affected by
 * enable_parallel_replicas on ClickHouse Cloud (ObsessionDB).
 *
 * Uses the hot key and slice ranges from ANALYSIS.md.
 */
import { close, DB, TABLE, PARTITION_ID, timed } from './ch-client.js'

const HOT_KEY = 'CWE8jPTUYhdCTZYWPTe1o5DFqfdjzWKc9WKz6rSjQUdG'
// Slice 22 range from analysis
const SLICE_FROM = '427ebe02dc1b56c7'
const SLICE_TO = '4378ddebb790f1ff'

interface TestCase {
  label: string
  sql: string
}

const tests: TestCase[] = [
  // 1. min/max on first sort key (full partition)
  {
    label: 'min/max contract_address (full partition)',
    sql: `SELECT
  toString(min(contract_address)) AS minVal,
  toString(max(contract_address)) AS maxVal
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'`,
  },

  // 2. min/max on second sort key (pinned hot key)
  {
    label: 'min/max block_timestamp (pinned hot key)',
    sql: `SELECT
  toString(min(block_timestamp)) AS minVal,
  toString(max(block_timestamp)) AS maxVal
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
  AND contract_address = '${HOT_KEY}'`,
  },

  // 3. GROUP BY substring (string prefix distribution)
  {
    label: 'GROUP BY substring(contract_address, 1, 1)',
    sql: `SELECT
  substring(contract_address, 1, 1) AS prefix,
  count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
GROUP BY prefix
ORDER BY prefix`,
  },

  // 4. GROUP BY contract_address within slice 22 range
  {
    label: 'GROUP BY contract_address (slice 22)',
    sql: `SELECT
  contract_address,
  count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
  AND contract_address >= unhex('${SLICE_FROM}')
  AND contract_address < unhex('${SLICE_TO}')
GROUP BY contract_address
ORDER BY cnt DESC
LIMIT 20`,
  },

  // 5. GROUP BY toStartOfDay (temporal distribution, pinned hot key)
  {
    label: 'GROUP BY toStartOfDay (pinned hot key)',
    sql: `SELECT
  formatDateTime(toStartOfDay(block_timestamp), '%Y-%m-%dT%H:%i:%sZ') AS bucket,
  count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'
  AND contract_address = '${HOT_KEY}'
GROUP BY bucket
ORDER BY bucket`,
  },

  // 6. count() as control (known to be affected)
  {
    label: 'count() (control — known affected)',
    sql: `SELECT count() AS cnt
FROM ${DB}.${TABLE}
WHERE _partition_id = '${PARTITION_ID}'`,
  },
]

async function timedWithTimeout<T>(sql: string, timeoutMs: number): Promise<[T[], number] | 'timeout'> {
  const start = performance.now()
  const result = await Promise.race([
    timed<T>(sql),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ])
  if (result === 'timeout') return 'timeout'
  return result
}

const QUERY_TIMEOUT = 30_000

async function run() {
  console.log('=== Parallel Replicas Impact Test ===\n')
  console.log(`Table: ${DB}.${TABLE}, Partition: ${PARTITION_ID}\n`)
  console.log('Expected partition rows from system.parts: 535,310,542\n')

  for (const test of tests) {
    console.log(`--- ${test.label} ---`)

    // With parallel replicas (default)
    const onResult = await timedWithTimeout<Record<string, string>>(test.sql, QUERY_TIMEOUT)
    // Without parallel replicas
    const offResult = await timedWithTimeout<Record<string, string>>(
      `${test.sql}\nSETTINGS enable_parallel_replicas=0`,
      QUERY_TIMEOUT,
    )

    if (onResult === 'timeout' || offResult === 'timeout') {
      console.log(`  replicas=ON:  ${onResult === 'timeout' ? 'TIMEOUT (>30s)' : `ok (${(onResult[1] / 1000).toFixed(2)}s)`}`)
      console.log(`  replicas=OFF: ${offResult === 'timeout' ? 'TIMEOUT (>30s)' : `ok (${(offResult[1] / 1000).toFixed(2)}s)`}`)
      console.log()
      continue
    }

    const [resultOn, msOn] = onResult
    const [resultOff, msOff] = offResult

    const isGroupBy = resultOn.length > 1

    if (isGroupBy) {
      // For GROUP BY queries, compare total row counts
      const sumOn = resultOn.reduce((acc, r) => acc + Number(r.cnt ?? 0), 0)
      const sumOff = resultOff.reduce((acc, r) => acc + Number(r.cnt ?? 0), 0)
      const ratio = sumOn / sumOff

      console.log(`  replicas=ON:  ${resultOn.length} groups, sum(cnt)=${sumOn.toLocaleString()} (${(msOn / 1000).toFixed(2)}s)`)
      console.log(`  replicas=OFF: ${resultOff.length} groups, sum(cnt)=${sumOff.toLocaleString()} (${(msOff / 1000).toFixed(2)}s)`)
      console.log(`  ratio: ${ratio.toFixed(2)}x`)

      // Also show top 3 values for comparison
      const topOn = resultOn.slice(0, 3)
      const topOff = resultOff.slice(0, 3)
      console.log(`  top values ON:  ${JSON.stringify(topOn)}`)
      console.log(`  top values OFF: ${JSON.stringify(topOff)}`)
    } else {
      // For scalar queries, compare the result directly
      console.log(`  replicas=ON:  ${JSON.stringify(resultOn[0])} (${(msOn / 1000).toFixed(2)}s)`)
      console.log(`  replicas=OFF: ${JSON.stringify(resultOff[0])} (${(msOff / 1000).toFixed(2)}s)`)

      // For count(), show the ratio
      if (resultOn[0]?.cnt && resultOff[0]?.cnt) {
        const ratio = Number(resultOn[0].cnt) / Number(resultOff[0].cnt)
        console.log(`  ratio: ${ratio.toFixed(2)}x`)
      }
    }

    console.log()
  }

  await close()
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
