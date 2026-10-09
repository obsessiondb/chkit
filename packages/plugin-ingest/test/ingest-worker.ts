import { createInterface } from 'node:readline'

import { createStatelessLiveExecutor, getLiveEnv } from '@chkit/clickhouse/e2e-testkit'
import { table } from '@chkit/core'

import { createClickHouseDestination, ingestionColumns } from '../src/destination.js'
import { runIngestion } from '../src/executor.js'
import { cursorState } from '../src/incremental.js'
import { createClickHouseJournal } from '../src/journal.js'
import { definePipeline, defineStream, selectStreams } from '../src/registry.js'
import type { DestinationAdapter } from '../src/types.js'

interface WorkerConfig {
  database: string
  journalTable: string
  targetId: string
  namespaceId: string
  destinationTable: string
  startedAt: string
  loseLoadAcknowledgements?: boolean
}

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const first = await lines.next()
if (first.done) throw new Error('The worker requires a configuration.')
const config: WorkerConfig = JSON.parse(first.value)
const executor = createStatelessLiveExecutor(getLiveEnv())
console.log(JSON.stringify({ status: 'ready' }))
await lines.next()

try {
  const destination = table({
    database: config.database, name: config.destinationTable,
    columns: [{ name: 'id', type: 'UInt64' }, ...ingestionColumns],
    engine: 'MergeTree()', orderBy: ['id'],
  })
  const stream = defineStream({
    id: config.namespaceId, destination,
    incremental: cursorState({ id: 'process.cursor', version: 1, parse: Number }),
    async *read({ selection }) {
      const state = Number(selection ?? 0)
      console.log(JSON.stringify({ status: 'fetching', state }))
      await lines.next()
      yield { id: `page:${state}`, rows: [{ id: state + 1 }], state: state + 1 }
    },
  })
  const pipeline = definePipeline({ id: config.namespaceId, streams: [stream], retry: { retries: 0 } })
  const direct = createClickHouseDestination(executor)
  let acknowledgementLost = false
  const load: DestinationAdapter = config.loseLoadAcknowledgements ? {
    async insert(input) {
      if (acknowledgementLost) throw new Error('destination unavailable')
      await direct.insert(input)
      acknowledgementLost = true
      throw new Error('destination acknowledgement lost')
    },
  } : direct
  const result = await runIngestion({ selected: selectStreams([pipeline], []), backfill: undefined }, {
    journal: createClickHouseJournal({ executor, database: config.database, targetId: config.targetId, table: config.journalTable }),
    destination: load, now: () => new Date(config.startedAt),
  })
  console.log(JSON.stringify({ status: 'finished', ok: result.ok, runId: result.runId, error: result.streams[0]?.error }))
} finally {
  await executor.close()
  process.stdin.destroy()
}
