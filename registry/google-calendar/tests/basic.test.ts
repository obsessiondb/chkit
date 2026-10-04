import { afterEach, expect, test } from 'bun:test'
import { runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { google_calendarPipeline } from '../index.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN

function setFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN
  else process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = originalToken
})

test.serial('Google Calendar follows page tokens and keeps cancellation payloads', async () => {
  process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = 'fixture'
  const tokens: Array<string | null> = []
  setFetch(async (input) => {
    const url = new URL(String(input))
    tokens.push(url.searchParams.get('pageToken'))
    return Response.json(url.searchParams.has('pageToken')
      ? { items: [{ id: 'cancelled', status: 'cancelled' }] }
      : { items: [{ id: 'active', summary: 'Call' }], nextPageToken: 'next' })
  })
  const destination = createMemoryDestination()
  const result = await runIngestion({ selected: selectStreams([google_calendarPipeline], []), backfill: undefined }, { journal: createMemoryJournal(), destination })
  expect(result.ok).toBe(true)
  expect(tokens).toEqual([null, 'next'])
  expect(destination.tables.get('default.google_calendar_events_raw')?.map((row) => row.raw)).toEqual([
    { id: 'active', summary: 'Call' }, { id: 'cancelled', status: 'cancelled' },
  ])
})
