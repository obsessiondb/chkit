import { afterEach, expect, test } from 'bun:test'
import { IngestConfigError, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { githubPipeline } from '../index.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.GITHUB_TOKEN
const cutoff = new Date('2026-01-02T00:00:00Z')

function setFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect })
  process.env.GITHUB_TOKEN = 'fixture'
}

function selected(resource = 'issues') {
  return selectStreams([githubPipeline], [`resource:${resource}`]).map((item) => ({ ...item, stream: { ...item.stream, batchSize: 1, retry: { retries: 0 } } }))
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalToken
})

test.serial('GitHub follows short-page Link continuations, bounds updates and preserves complete PR context', async () => {
  const paths: string[] = []
  setFetch(async (input) => {
    const url = new URL(String(input))
    paths.push(url.pathname + url.search)
    if (url.pathname.endsWith('/issues')) {
      expect(url.searchParams.get('since')).toBe('2008-01-01T00:00:00.000Z')
      expect(url.searchParams.get('sort')).toBe('updated')
      expect(url.searchParams.get('direction')).toBe('asc')
      if (url.searchParams.has('page')) return Response.json([
        { number: 2, updated_at: '2026-01-01T12:00:00Z', pull_request: { url: 'detail' } },
        { number: 3, updated_at: '2026-01-03T00:00:00Z' },
      ])
      return Response.json([{ number: 1, updated_at: '2026-01-01T12:00:00Z' }], {
        headers: { Link: `<https://api.github.com/repos/obsessiondb/chkit/issues?per_page=100&page=2&since=2008-01-01T00%3A00%3A00.000Z&sort=updated&direction=asc>; rel="next"` },
      })
    }
    if (url.pathname.endsWith('/pulls/2')) return Response.json({ changed_files: 2, commits: 1, custom: 'preserved' })
    if (url.pathname.endsWith('/files')) return Response.json([{ filename: 'file.ts' }])
    if (url.pathname.endsWith('/commits')) return Response.json([{ sha: 'a' }])
    return Response.json([{ id: 11, body: 'context' }])
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const result = await runIngestion({ selected: selected(), backfill: undefined }, { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(true)
  const rows = destination.tables.get('default.github_issues_raw') ?? []
  expect(rows.map((row) => row.id)).toEqual(['["obsessiondb/chkit",1]', '["obsessiondb/chkit",2]'])
  expect(rows[1]?.raw).toMatchObject({ pull_detail: { custom: 'preserved' }, comment_items: [{ id: 11 }], _chkit_context: { files_complete: false, commits_complete: true } })
  expect(paths.some((path) => path.includes('/issues/3/comments'))).toBe(false)
  expect((await journal.readCheckpoint('github.issues.obsessiondb.chkit')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
})

test.serial('GitHub child failures replay the issue window and destination failures cannot advance it', async () => {
  let failComments = true
  const starts: string[] = []
  setFetch(async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/issues')) {
      starts.push(url.searchParams.get('since') ?? '')
      return Response.json([{ number: 1, updated_at: '2026-01-01T12:00:00Z' }])
    }
    return failComments ? new Response('denied', { status: 403 }) : Response.json([])
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selected(), backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('github.issues.obsessiondb.chkit')).envelope).toBeUndefined()
  failComments = false
  expect((await runIngestion(request, { journal, destination: { insert: async () => { throw new IngestConfigError('sink rejected') } }, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('github.issues.obsessiondb.chkit')).envelope).toBeUndefined()
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(starts).toEqual(Array(3).fill('2008-01-01T00:00:00.000Z'))
})

test.serial('GitHub subsequent issue scans overlap the committed watermark', async () => {
  const starts: string[] = []
  setFetch(async (input) => {
    starts.push(new URL(String(input)).searchParams.get('since') ?? '')
    return Response.json([])
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selected(), backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-03T00:00:00Z') })).ok).toBe(true)
  expect(starts).toEqual(['2008-01-01T00:00:00.000Z', '2026-01-01T23:55:00.000Z'])
})

test.serial('GitHub empty stargazer scans persist completion and always read again', async () => {
  const paths: string[] = []
  setFetch(async (input) => { paths.push(String(input)); return Response.json([]) })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selected('stargazers'), backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-03T00:00:00Z') })).ok).toBe(true)
  expect(paths).toHaveLength(2)
  expect(paths.every((path) => !new URL(path).searchParams.has('since'))).toBe(true)
  expect((await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')).envelope?.state).toEqual({ completedAt: '2026-01-03T00:00:00.000Z' })
})
