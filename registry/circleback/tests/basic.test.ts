import { afterEach, expect, test } from 'bun:test'
import { runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { circlebackPipeline } from '../index.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.CIRCLEBACK_API_KEY

function setFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.CIRCLEBACK_API_KEY
  else process.env.CIRCLEBACK_API_KEY = originalToken
})

test.serial('Circleback follows the Link cursor and joins available transcripts', async () => {
  process.env.CIRCLEBACK_API_KEY = 'fixture'
  const paths: string[] = []
  setFetch(async (input) => {
    const url = new URL(String(input))
    paths.push(url.pathname + url.search)
    if (url.pathname.endsWith('/transcript')) return url.pathname.includes('/b/') ? new Response('', { status: 404 }) : Response.json([{ text: 'Hello' }])
    if (url.searchParams.has('cursor')) return Response.json([{ id: 'b', name: 'Second' }])
    return Response.json([{ id: 'a', name: 'First' }], { headers: { Link: '</api/meetings?cursor=next>; rel="next"' } })
  })
  const destination = createMemoryDestination()
  const result = await runIngestion({ selected: selectStreams([circlebackPipeline], []), backfill: undefined }, { journal: createMemoryJournal(), destination })
  expect(result.ok).toBe(true)
  expect(paths).toEqual(['/api/meetings?ownership=All', '/api/meeting/a/transcript', '/api/meetings?cursor=next', '/api/meeting/b/transcript'])
  const rows = destination.tables.get('default.circleback_meetings_raw') ?? []
  expect(rows.map((row) => row.id)).toEqual(['a', 'b'])
  expect(rows[0]?.raw).toMatchObject({ transcript: [{ text: 'Hello' }] })
  expect(rows[1]?.raw).toMatchObject({ transcript: null })
})
