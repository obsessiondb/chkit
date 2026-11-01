import { createInterface } from 'node:readline'

import { LOCAL_STACK_ENV } from '@chkit/clickhouse/e2e-testkit'
import { table } from '@chkit/core'
import {
  createClickHouseDestination, createClickHouseJournal, createStagedLoaderExecutor, cursorState, definePipeline, defineStream,
  ingestionColumns, runIngestion, selectStreams, stagedLoader,
} from '@chkit/plugin-ingest'

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const first = await lines.next()
if (first.done) throw new Error('The staged-loader worker requires configuration')
const config = JSON.parse(first.value)
const executor = createStagedLoaderExecutor({
  url: LOCAL_STACK_ENV.clickhouseUrl,
  username: LOCAL_STACK_ENV.clickhouseUser,
  password: LOCAL_STACK_ENV.clickhousePassword,
  database: config.database,
})
try {
  const insertSizes = []
  const wrapped = {
    ...executor,
    async insert(params) {
      await executor.insert(params)
      insertSizes.push(params.values.length)
      if (config.mode === 'hold-after-stage') {
        console.log(JSON.stringify({ status: 'staged', table: params.table }))
        await new Promise(() => { setInterval(() => {}, 60_000) })
      }
    },
    async submit(sql, id, settings) {
      const queryId = await executor.submit(sql, id, settings)
      if (config.mode === 'lost-ack') {
        console.log(JSON.stringify({ status: 'published', queryId }))
        throw new Error('injected publication acknowledgement loss')
      }
      return queryId
    },
    async query(sql, settings) {
      return config.mode === 'lost-ack' && sql.includes('system.query_log') ? [] : executor.query(sql, settings)
    },
  }
  const destination = table({
    database: config.database, name: config.destination,
    columns: [{ name: 'id', type: 'UInt64' }, { name: 'value', type: 'String' }, ...ingestionColumns],
    engine: 'MergeTree()', orderBy: ['id'],
  })
  const stream = defineStream({
    id: config.namespaceId, destination,
    incremental: cursorState({ id: 'staged.recovery', version: 1, parse: Number }),
    loader: stagedLoader({
      executor: wrapped, keys: ['id'], winner: 'first', concurrency: 'single-process',
      maxRowsPerInsert: config.maxRowsPerInsert, reconciliationTimeoutMs: 20,
    }),
    async *read({ selection }) {
      console.log(JSON.stringify({ status: 'reading', selection: Number(selection ?? 0) }))
      yield {
        id: 'page:0', state: 1,
        rows: [{ id: 1, value: 'first' }, { id: 2, value: 'second' }, { id: 1, value: 'ignored' }],
      }
    },
  })
  const result = await runIngestion({
    selected: selectStreams([definePipeline({ id: config.namespaceId, streams: [stream], retry: { retries: 0 } })], []),
    backfill: undefined,
  }, {
    journal: createClickHouseJournal({ executor, database: config.database, targetId: config.targetId, table: config.journalTable }),
    destination: createClickHouseDestination(executor),
  })
  console.log(JSON.stringify({ status: 'finished', ok: result.ok, runId: result.runId, error: result.streams[0]?.error, insertSizes }))
} finally {
  await executor.close()
  process.stdin.destroy()
}
