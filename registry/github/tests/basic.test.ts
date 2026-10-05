import { afterEach, expect, test } from 'bun:test'
import { IngestConfigError, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { createGitHubPipeline, githubPipeline } from '../index.js'
import { githubConfig } from '../config.js'

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

test.serial('GitHub empty stargazer full syncs journal completion and always read again', async () => {
  const paths: string[] = []
  setFetch(async (input) => { paths.push(String(input)); return Response.json([]) })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selected('stargazers'), backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect((await runIngestion(request, { journal, destination, now: () => new Date('2026-01-03T00:00:00Z') })).ok).toBe(true)
  expect(paths).toHaveLength(2)
  expect(paths.every((path) => !new URL(path).searchParams.has('since'))).toBe(true)
  const state = await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')
  expect(state.envelope).toBeUndefined()
  expect(state.lastSuccessSeq).toBeGreaterThan(0)
  expect(journal.events.filter((event) => event.namespaceId === 'github.stargazers.obsessiondb.chkit' && event.eventKind === 'work_finished' && event.workState === 'succeeded')).toHaveLength(2)
})

test.serial('GitHub binds configuration and isolates resource and repository failures in one pipeline', async () => {
  const requests: URL[] = []
  let failFirstIssues = true
  const config = {
    ...githubConfig, sourceId: 'github.fixture', repositories: ['first/repo', 'second/repo'],
    pageSize: 25, start: new Date('2025-01-01'), overlapMs: 60_000,
  }
  const pipeline = createGitHubPipeline(config, {
    token: () => 'bound-token',
    fetch: async (input, init) => {
      const url = new URL(input)
      requests.push(url)
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer bound-token')
      expect(url.searchParams.get('per_page')).toBe('25')
      if (url.pathname === '/repos/first/repo/issues' && failFirstIssues) return new Response('denied', { status: 403 })
      if (url.pathname.endsWith('/stargazers')) return Response.json([{ user: { id: 9 }, custom: true }])
      return Response.json([])
    },
  })
  config.pageSize = 100
  config.repositories.push('third/repo')
  config.start.setUTCFullYear(2000)
  config.overlapMs = 60 * 60 * 1000
  expect(pipeline.streams.map((stream) => stream.id)).toEqual([
    'github.fixture.issues.first.repo', 'github.fixture.stargazers.first.repo',
    'github.fixture.issues.second.repo', 'github.fixture.stargazers.second.repo',
  ])
  const selected = selectStreams([pipeline], []).map((item) => ({ ...item, stream: { ...item.stream, retry: { retries: 0 } } }))
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const result = await runIngestion({ selected, backfill: undefined }, { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams.filter((stream) => stream.outcome === 'succeeded')).toHaveLength(3)
  expect((await journal.readCheckpoint('github.fixture.issues.first.repo')).envelope).toBeUndefined()
  expect((await journal.readCheckpoint('github.fixture.issues.second.repo')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
  expect(destination.tables.get('default.github_stargazers_raw')?.map((row) => row.id)).toEqual(['["first/repo",9]', '["second/repo",9]'])
  expect(requests.filter((url) => url.pathname.endsWith('/issues')).every((url) => url.searchParams.get('since') === '2025-01-01T00:00:00.000Z')).toBe(true)

  requests.length = 0
  failFirstIssues = false
  const onlySecondIssues = selectStreams([pipeline], ['repository:second/repo', 'resource:issues'])
  expect(onlySecondIssues.map((item) => item.stream.id)).toEqual(['github.fixture.issues.second.repo'])
  expect((await runIngestion({ selected: onlySecondIssues, backfill: undefined }, { journal, destination, now: () => new Date('2026-01-03') })).ok).toBe(true)
  expect(requests.map((url) => url.pathname)).toEqual(['/repos/second/repo/issues'])
  expect(requests[0]?.searchParams.get('since')).toBe('2026-01-01T23:59:00.000Z')
  expect((await journal.readCheckpoint('github.fixture.issues.first.repo')).envelope).toBeUndefined()
})

test.serial('GitHub retries each paginated request once under executor authority', async () => {
  let attempts = 0
  const pipeline = createGitHubPipeline(githubConfig, {
    token: () => 'fixture',
    fetch: async () => {
      attempts++
      if (attempts === 1) return new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '0' } })
      return Response.json([])
    },
  })
  const selected = selectStreams([pipeline], ['resource:stargazers']).map((item) => ({ ...item, stream: { ...item.stream, retry: { retries: 1, minTimeout: 0, maxTimeout: 0 } } }))
  const journal = createMemoryJournal()
  const result = await runIngestion({ selected, backfill: undefined }, { journal, destination: createMemoryDestination(), now: () => cutoff })
  expect(result.ok).toBe(true)
  expect(attempts).toBe(2)
  expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled' && event.errorClass === 'rate_limited')).toHaveLength(1)
})

test.serial('GitHub stargazer failures replay from the first page before journaling full-sync completion', async () => {
  let failSecondPage = true
  const starts: string[] = []
  setFetch(async (input) => {
    const url = new URL(String(input))
    if (url.searchParams.has('page')) return failSecondPage ? new Response('denied', { status: 403 }) : Response.json([{ user: { id: 43 } }])
    starts.push(url.search)
    return Response.json([{ user: { id: 42 } }], { headers: { Link: '<https://api.github.com/repos/obsessiondb/chkit/stargazers?per_page=100&page=2>; rel="next"' } })
  })
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const request = { selected: selected('stargazers'), backfill: undefined }
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')).lastSuccessSeq).toBe(0)
  failSecondPage = false
  expect((await runIngestion(request, { journal, destination: { insert: async () => { throw new IngestConfigError('sink rejected') } }, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')).lastSuccessSeq).toBe(0)
  expect((await runIngestion(request, { journal, destination, now: () => cutoff })).ok).toBe(true)
  const completed = await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')
  expect(completed.envelope).toBeUndefined()
  expect(completed.lastSuccessSeq).toBeGreaterThan(0)
  expect(starts).toEqual(Array(3).fill('?per_page=100'))
  expect(destination.tables.get('default.github_stargazers_raw')?.map((row) => row.id)).toEqual(['["obsessiondb/chkit",42]', '["obsessiondb/chkit",43]'])
})

test.serial('GitHub refuses repeated and foreign-origin Link continuations without completing the stream', async () => {
  for (const next of ['https://api.github.com/repos/obsessiondb/chkit/stargazers?per_page=100', 'https://example.com/steal']) {
    let requests = 0
    setFetch(async () => {
      requests++
      return Response.json([], { headers: { Link: `<${next}>; rel="next"` } })
    })
    const journal = createMemoryJournal()
    const result = await runIngestion({ selected: selected('stargazers'), backfill: undefined }, { journal, destination: createMemoryDestination(), now: () => cutoff })
    expect(result.ok).toBe(false)
    expect(requests).toBe(1)
    expect((await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')).lastSuccessSeq).toBe(0)
  }
})
