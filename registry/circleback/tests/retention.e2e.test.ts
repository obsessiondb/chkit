import { afterAll, expect, test } from 'bun:test'
import { createLiveExecutor, createPrefix, getLiveEnv, pollUntil, quoteIdent, waitForTable } from '@chkit/clickhouse/e2e-testkit'
import { toCreateSQL } from '@chkit/core'
import { createClickHouseDestination, rawTable, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { circlebackConfig } from '../config.js'
import { createCirclebackPipeline } from '../pipeline.js'

const env = getLiveEnv()
const executor = createLiveExecutor(env)
const destination = rawTable({ database: env.clickhouseDatabase, name: `${createPrefix('circleback_retention')}transcripts_raw` })
const qualified = `${quoteIdent(destination.database)}.${quoteIdent(destination.name)}`

// On a multi-replica service a read can land on a replica that hasn't seen the
// latest ingestion yet, so re-read until the expected snapshot is visible.
async function settledRaw(transcript: unknown, status: string): Promise<Array<{ kind: string; data?: unknown; status?: string }>> {
  return pollUntil(
    async () => {
      const rows = await executor.query<{ payload: string }>(`SELECT toJSONString(raw) AS payload FROM ${qualified} FINAL`)
      return rows.map(({ payload }) => JSON.parse(payload))
    },
    (raw) =>
      raw.length === 2 &&
      JSON.stringify(raw.find((item) => item.kind === 'transcript')?.data) === JSON.stringify(transcript) &&
      raw.find((item) => item.kind === 'availability')?.status === status,
  )
}

afterAll(async () => {
  await executor.command(`DROP TABLE IF EXISTS ${qualified}`)
  await executor.close()
})

test('ClickHouse retains successful transcript content through permission loss and replaces it after a successful empty read', async () => {
  await executor.command(toCreateSQL(destination))
  await waitForTable(executor, destination.database, destination.name)
  let responseStatus = 200
  let segments = [{ speaker: 'Fixture speaker', text: 'Retained speech', timestamp: 1.5 }]
  const source = createCirclebackPipeline({ ...circlebackConfig, sourceId: 'circleback.retention' }, {
    config: circlebackConfig, token: () => 'fixture',
    fetch: async (input) => new URL(input).pathname === '/api/meetings'
      ? Response.json([{ id: 'meeting-1' }])
      : responseStatus === 200 ? Response.json(segments) : new Response('unavailable', { status: responseStatus }),
  })
  const pipeline = { ...source, retry: { retries: 0 }, streams: source.streams.map((stream) => ({ ...stream, destination })) }
  const request = { selected: selectStreams([pipeline], ['resource:meeting_transcripts']), backfill: undefined }
  const journal = createMemoryJournal()
  for (const [httpStatus, status] of [[200, 'available'], [403, 'forbidden'], [404, 'not_found']] as const) {
    responseStatus = httpStatus
    expect((await runIngestion(request, { journal, destination: createClickHouseDestination(executor) })).ok).toBe(true)
    await executor.command(`OPTIMIZE TABLE ${qualified} FINAL`)
    const raw = await settledRaw(segments, status)
    expect(raw).toHaveLength(2)
    expect(raw.find((item) => item.kind === 'transcript')?.data).toEqual(segments)
    expect(raw.find((item) => item.kind === 'availability')?.status).toBe(status)
  }
  responseStatus = 200
  segments = []
  expect((await runIngestion(request, { journal, destination: createClickHouseDestination(executor) })).ok).toBe(true)
  await executor.command(`OPTIMIZE TABLE ${qualified} FINAL`)
  const raw = await settledRaw([], 'available')
  expect(raw).toHaveLength(2)
  expect(raw.find((item) => item.kind === 'transcript')?.data).toEqual([])
  expect(raw.find((item) => item.kind === 'availability')?.status).toBe('available')
  const expectedJoin = [{ meeting_id: 'meeting-1', status: 'available' }]
  const joined = await pollUntil(() => executor.query<{ meeting_id: string; status: string }>(`
    SELECT snapshot.raw.meeting_id::String AS meeting_id, outcome.raw.status::String AS status
    FROM ${qualified} AS snapshot FINAL
    INNER JOIN ${qualified} AS outcome FINAL
      ON snapshot.raw.source_id::String = outcome.raw.source_id::String
      AND snapshot.raw.meeting_id::String = outcome.raw.meeting_id::String
    WHERE snapshot.raw.kind::String = 'transcript' AND outcome.raw.kind::String = 'availability'
  `), (rows) => JSON.stringify(rows) === JSON.stringify(expectedJoin))
  expect(joined).toEqual(expectedJoin)
})
