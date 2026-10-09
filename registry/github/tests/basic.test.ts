import { expect, test } from 'bun:test'
import { HttpError, IngestConfigError, runIngestion, selectStreams, type FetchContext, type Page } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

import { createGitHubPipeline, githubPipeline } from '../index.js'
import { githubConfig, type GitHubConfig } from '../config.js'
import { classifyGitHubError, readIssuePages, requestGitHubGraphql, type GitHubObject } from '../client.js'

const repository = 'obsessiondb/chkit'
const cutoff = new Date('2026-01-02T00:00:00Z')
const resources = ['issues', 'issue_comments', 'pull_requests', 'pull_request_comments', 'pull_request_review_comments', 'pull_request_reviews', 'pull_request_commits', 'stargazers']
const issue = { number: 1, id: 1001, title: 'Issue', updated_at: '2026-01-01T12:00:00Z', labels: [{ name: 'bug' }] }
const pull = { number: 2, id: 1002, title: 'Pull request', state: 'closed', updated_at: '2026-01-01T12:00:00Z', merged_at: '2026-01-01T00:00:00Z' }
const pullIssue = { ...pull, pull_request: { url: `https://api.github.com/repos/${repository}/pulls/2` } }
const issueComment = { id: 101, body: 'Issue discussion', updated_at: issue.updated_at, custom: ['retained'] }
const pullComment = { id: 201, body: 'Pull request discussion', updated_at: issue.updated_at }
const reviewComment = { id: 301, body: 'Review discussion', updated_at: issue.updated_at, pull_request_url: `https://api.github.com/repos/${repository}/pulls/2` }
const review = { id: 401, body: 'Review', state: 'APPROVED', submitted_at: '2020-01-01T00:00:00Z' }
const commit = { sha: '0123456789012345678901234567890123456789', message: 'Subject\n\nFull commit message\nwith another line.' }
const stargazer = { starred_at: '2026-01-01T00:00:00Z', user: { id: 501, login: 'example' }, custom: true }

type Responder = (url: URL, init: RequestInit) => Response | Promise<Response>
type Pipeline = ReturnType<typeof createGitHubPipeline>

test('GitHub resource streams retain flat provider payloads and parent join identities', async () => {
  const requests: URL[] = []
  const pipeline = fixturePipeline((url, init) => { requests.push(url); return fixtureResponse(url, init) })
  expect(pipeline.streams.map((stream) => stream.id).sort()).toEqual(resources.map((resource) => `github.${resource}.obsessiondb.chkit`).sort())
  expect(githubPipeline.streams).toHaveLength(8)
  const destination = createMemoryDestination(), journal = createMemoryJournal()
  const result = await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  const expected: Record<string, { id: string; raw: unknown }> = {
    issues: { id: JSON.stringify([repository, 1]), raw: { repository, data: issue } },
    issue_comments: { id: JSON.stringify([repository, 1, 101]), raw: { repository, issue_number: 1, data: issueComment } },
    pull_requests: { id: JSON.stringify([repository, 2]), raw: { repository, data: pull } },
    pull_request_comments: { id: JSON.stringify([repository, 2, 201]), raw: { repository, pull_number: 2, data: pullComment } },
    pull_request_review_comments: { id: JSON.stringify([repository, 2, 301]), raw: { repository, pull_number: 2, data: reviewComment } },
    pull_request_reviews: { id: JSON.stringify([repository, 2, 401]), raw: { repository, pull_number: 2, data: review } },
    pull_request_commits: { id: JSON.stringify([repository, 2, commit.sha]), raw: { repository, pull_number: 2, data: commit } },
    stargazers: { id: JSON.stringify([repository, 501]), raw: { repository, data: stargazer } },
  }
  for (const [resource, expectedRow] of Object.entries(expected)) {
    expect(destination.tables.get(`default.github_${resource}_raw`)?.map(({ id, raw }) => ({ id, raw }))).toEqual([expectedRow])
  }
  expect(requests.some((url) => url.pathname.endsWith('/files') || /\/pulls\/\d+\/commits$/.test(url.pathname))).toBe(false)
  expect((await journal.readCheckpoint('github.issues.obsessiondb.chkit')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
})

test('every resource runs alone and reversing stream order preserves the same observations', async () => {
  const pipeline = fixturePipeline()
  const combined = createMemoryDestination()
  const reversed = { ...pipeline, streams: [...pipeline.streams].reverse() }
  expect((await runIngestion(request(reversed), { journal: createMemoryJournal(), destination: combined, now: () => cutoff })).ok).toBe(true)
  for (const resource of resources) {
    const destination = createMemoryDestination()
    const selected = request(pipeline, resource)
    expect(selected.selected.map((entry) => entry.stream.id)).toEqual([`github.${resource}.obsessiondb.chkit`])
    const result = await runIngestion(selected, { journal: createMemoryJournal(), destination, now: () => cutoff })
    expect(result.ok, `${resource}: ${JSON.stringify(result)}`).toBe(true)
    expect(destination.tables.size).toBe(1)
    expect(destination.tables.get(`default.github_${resource}_raw`)?.map(({ id, raw }) => ({ id, raw })))
      .toEqual(combined.tables.get(`default.github_${resource}_raw`)?.map(({ id, raw }) => ({ id, raw })))
  }
})

test('selecting parents requests no children and separates issue and pull request responses', async () => {
  for (const resource of ['issues', 'pull_requests']) {
    const requests: URL[] = []
    const pipeline = fixturePipeline((url, init) => { requests.push(url); return fixtureResponse(url, init) })
    const destination = createMemoryDestination()
    expect((await runIngestion(request(pipeline, resource), { journal: createMemoryJournal(), destination, now: () => cutoff })).ok).toBe(true)
    expect(requests.map((url) => url.pathname)).toEqual([`/repos/${repository}/${resource === 'issues' ? 'issues' : 'pulls'}`])
    expect(requests[0]?.searchParams.get('state')).toBe('all')
    expect(requests[0]?.searchParams.get('sort')).toBe('updated')
    expect(requests[0]?.searchParams.get('direction')).toBe('asc')
    expect(requests[0]?.searchParams.has('since')).toBe(resource === 'issues')
    expect(destination.tables.get(`default.github_${resource}_raw`)?.map((row) => row.raw)).toEqual([{ repository, data: resource === 'issues' ? issue : pull }])
  }
})

test('short issue pages follow Link continuations while excluding PRs and updates beyond the cutoff', async () => {
  const requests: URL[] = []
  const nextIssue = { ...issue, number: 3, id: 1003 }
  const futureIssue = { ...issue, number: 4, updated_at: '2026-01-03T00:00:00Z' }
  const pipeline = fixturePipeline((url) => {
    requests.push(url)
    if (url.searchParams.has('page')) return Response.json([pullIssue, nextIssue, futureIssue])
    return Response.json([issue], { headers: { Link: `<${url}&page=2>; rel="next"` } })
  })
  const destination = createMemoryDestination(), journal = createMemoryJournal()
  const result = await runIngestion(request(pipeline, 'issues'), { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(true)
  expect(requests).toHaveLength(2)
  expect(requests.every((url) => url.searchParams.get('since') === '2008-01-01T00:00:00.000Z')).toBe(true)
  expect(destination.tables.get('default.github_issues_raw')?.map((row) => row.raw)).toEqual([{ repository, data: issue }, { repository, data: nextIssue }])
  expect((await journal.readCheckpoint('github.issues.obsessiondb.chkit')).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
})

test('issue page filtering preserves continuations and empty terminal pages', async () => {
  const signal = new AbortController().signal
  const context: FetchContext = { signal, attempt: (operation) => operation(signal) }
  const pages: Page<GitHubObject, string>[] = []
  const requests: URL[] = []
  for await (const page of readIssuePages(context, repository, githubConfig, {
    token: () => 'fixture', fetch: async (input) => {
      const url = new URL(input)
      requests.push(url)
      const number = Number(url.searchParams.get('page') ?? '1')
      const next = new URL(url)
      next.searchParams.set('page', String(number + 1))
      return Response.json(number === 1 ? [pullIssue] : number === 2 ? [issue] : [],
        { headers: number < 3 ? { Link: `<${next}>; rel="next"` } : {} })
    },
  })) pages.push(page)
  expect(requests).toHaveLength(3)
  expect(pages.map((page) => page.items)).toEqual([[], [issue], []])
  expect(pages.map((page) => page.next)).toEqual([requests[1]?.toString(), requests[2]?.toString(), undefined])
})

test('a failed child stream does not block its parents or the other resource checkpoints', async () => {
  const pipeline = fixturePipeline((url, init) => url.pathname.endsWith('/issues/1/comments')
    ? new Response('denied', { status: 403 }) : fixtureResponse(url, init))
  const destination = createMemoryDestination(), journal = createMemoryJournal()
  const result = await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })
  expect(result.ok).toBe(false)
  expect(result.streams.filter((stream) => stream.outcome === 'failed').map((stream) => stream.streamId)).toEqual(['github.issue_comments.obsessiondb.chkit'])
  expect(result.streams.filter((stream) => stream.outcome === 'succeeded')).toHaveLength(7)
  expect(destination.tables.has('default.github_issues_raw')).toBe(true)
  expect(destination.tables.has('default.github_pull_requests_raw')).toBe(true)
  expect((await journal.readCheckpoint('github.issue_comments.obsessiondb.chkit')).envelope).toBeUndefined()
  for (const resource of ['issues', 'pull_request_comments', 'pull_request_review_comments']) {
    expect((await journal.readCheckpoint(`github.${resource}.obsessiondb.chkit`)).envelope?.state).toEqual({ watermark: cutoff.toISOString() })
  }
  expect((await journal.readCheckpoint('github.pull_requests.obsessiondb.chkit')).lastSuccessSeq).toBeGreaterThan(0)
})

test('comment streams capture edits on old parents using their own overlapping since windows', async () => {
  const oldIssue = { ...issue, number: 3, updated_at: '2020-01-01T00:00:00Z' }
  const oldPull = { ...pull, number: 4, updated_at: '2020-01-01T00:00:00Z' }
  for (const resource of ['issue_comments', 'pull_request_comments', 'pull_request_review_comments']) {
    let edited = false
    const requests: URL[] = []
    const pipeline = fixturePipeline((url) => {
      requests.push(url)
      if (url.pathname.endsWith('/issues')) return Response.json([oldIssue, { ...oldPull, pull_request: pullIssue.pull_request }])
      if (url.pathname.endsWith('/pulls')) return Response.json([oldPull])
      const comment = resource === 'issue_comments' ? issueComment : resource === 'pull_request_comments' ? pullComment : reviewComment
      const data = { ...comment, body: edited ? 'Edited old discussion' : 'Original discussion', updated_at: edited ? '2026-01-02T12:00:00Z' : '2026-01-01T12:00:00Z',
        ...(resource === 'pull_request_review_comments' ? { pull_request_url: `https://api.github.com/repos/${repository}/pulls/4` } : {}) }
      return Response.json([data, { ...data, id: 999, updated_at: '2026-01-04T00:00:00Z' }])
    })
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    expect((await runIngestion(request(pipeline, resource), { journal, destination, now: () => cutoff })).ok).toBe(true)
    edited = true
    expect((await runIngestion(request(pipeline, resource), { journal, destination, now: () => new Date('2026-01-03') })).ok).toBe(true)
    const children = requests.filter((url) => url.pathname.endsWith('/comments'))
    expect(children.map((url) => url.searchParams.get('since'))).toEqual(['2008-01-01T00:00:00.000Z', '2026-01-01T23:55:00.000Z'])
    expect(requests.filter((url) => url.pathname.endsWith('/issues') || url.pathname.endsWith('/pulls')).every((url) => !url.searchParams.has('since'))).toBe(true)
    const rows = destination.tables.get(`default.github_${resource}_raw`) ?? []
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id)).size).toBe(1)
    expect(rows.at(-1)?.raw).toMatchObject({ repository, data: { body: 'Edited old discussion' } })
    expect((await journal.readCheckpoint(`github.${resource}.obsessiondb.chkit`)).envelope?.state).toEqual({ watermark: '2026-01-03T00:00:00.000Z' })
  }
})

test('a rejected child write cannot advance its timestamp watermark and the next run replays the window', async () => {
  const starts: string[] = []
  const pipeline = fixturePipeline((url, init) => {
    if (url.pathname.endsWith('/comments')) starts.push(url.searchParams.get('since') ?? '')
    return fixtureResponse(url, init)
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const selected = request(pipeline, 'issue_comments')
  const failed = await runIngestion(selected, { journal, destination: { insert: async () => { throw new IngestConfigError('sink rejected') } }, now: () => cutoff })
  expect(failed.ok).toBe(false)
  expect((await journal.readCheckpoint('github.issue_comments.obsessiondb.chkit')).envelope).toBeUndefined()
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(starts).toEqual(['2008-01-01T00:00:00.000Z', '2008-01-01T00:00:00.000Z'])
  expect(destination.tables.get('default.github_issue_comments_raw')).toHaveLength(1)
})

test('empty resource runs complete independently and full readers scan again without provider state', async () => {
  const calls: string[] = []
  const pipeline = fixturePipeline((url) => { calls.push(url.pathname); return Response.json([]) })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  for (const now of [cutoff, new Date('2026-01-03')]) expect((await runIngestion(request(pipeline), { journal, destination, now: () => now })).ok).toBe(true)
  expect(destination.tables.size).toBe(0)
  for (const resource of ['pull_requests', 'pull_request_reviews', 'pull_request_commits', 'stargazers']) {
    const checkpoint = await journal.readCheckpoint(`github.${resource}.obsessiondb.chkit`)
    expect(checkpoint.envelope).toBeUndefined()
    expect(checkpoint.lastSuccessSeq).toBeGreaterThan(0)
    expect(journal.events.filter((event) => event.namespaceId === `github.${resource}.obsessiondb.chkit` && event.eventKind === 'work_finished' && event.workState === 'succeeded')).toHaveLength(2)
  }
  expect(calls.filter((path) => path.endsWith('/stargazers'))).toHaveLength(2)
  expect((await journal.readCheckpoint('github.issue_comments.obsessiondb.chkit')).envelope?.state).toEqual({ watermark: '2026-01-03T00:00:00.000Z' })
})

test('stargazer full sync replays from its first page after page or destination failures before completing', async () => {
  let failSecondPage = true
  const starts: string[] = []
  const second = { ...stargazer, user: { id: 502, login: 'another-example' } }
  const pipeline = fixturePipeline((url) => {
    if (url.searchParams.get('page') === '2') return failSecondPage ? new Response('denied', { status: 403 }) : Response.json([second])
    starts.push(url.search)
    return Response.json([stargazer], { headers: { Link: `<${url}&page=2>; rel="next"` } })
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  const selected = request(pipeline, 'stargazers')
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(false)
  expect((await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')).lastSuccessSeq).toBe(0)
  expect((await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')).envelope).toBeUndefined()
  failSecondPage = false
  const rejected = await runIngestion(selected, { journal, now: () => cutoff,
    destination: { insert: async () => { throw new IngestConfigError('sink rejected') } } })
  expect(rejected.ok).toBe(false)
  expect((await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')).lastSuccessSeq).toBe(0)
  expect((await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')).envelope).toBeUndefined()
  expect((await runIngestion(selected, { journal, destination, now: () => cutoff })).ok).toBe(true)
  const completed = await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')
  expect(completed.lastSuccessSeq).toBeGreaterThan(0)
  expect(completed.envelope).toBeUndefined()
  expect(starts).toEqual(Array(3).fill('?per_page=100'))
  expect(destination.tables.get('default.github_stargazers_raw')?.map(({ id, raw }) => ({ id, raw }))).toEqual([
    { id: JSON.stringify([repository, 501]), raw: { repository, data: stargazer } },
    { id: JSON.stringify([repository, 502]), raw: { repository, data: second } },
  ])
})

test('GraphQL commits collect more than 250 entries and retain only SHA and the full multiline message', async () => {
  const commits = Array.from({ length: 275 }, (_, index) => ({ sha: (index + 1).toString(16).padStart(40, '0'), message: `Subject ${index}\n\nFull body ${index}\nLast line.` }))
  const afters: unknown[] = [], requests: URL[] = []
  const pipeline = fixturePipeline((url, init) => {
    requests.push(url)
    if (url.pathname !== '/graphql') return fixtureResponse(url, init)
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    const after = body.variables.after ?? null
    afters.push(after)
    const offset = after === 'page-100' ? 100 : after === 'page-200' ? 200 : 0
    const items = commits.slice(offset, offset + 100)
    return commitPage(items, commits.length, offset + items.length < commits.length ? `page-${offset + items.length}` : null)
  })
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline, 'pull_request_commits'), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(afters).toEqual([null, 'page-100', 'page-200'])
  const rows = destination.tables.get('default.github_pull_request_commits_raw') ?? []
  expect(rows).toHaveLength(275)
  expect(rows.map((row) => row.raw)).toEqual(commits.map((data) => ({ repository, pull_number: 2, data })))
  expect(rows.at(-1)?.id).toBe(JSON.stringify([repository, 2, commits.at(-1)?.sha]))
  expect(requests.filter((url) => url.pathname !== '/graphql').map((url) => url.pathname)).toEqual([`/repos/${repository}/pulls`])
  expect((await journal.readCheckpoint('github.pull_request_commits.obsessiondb.chkit')).envelope).toBeUndefined()
  expect((await journal.readCheckpoint('github.pull_request_commits.obsessiondb.chkit')).lastSuccessSeq).toBeGreaterThan(0)
})

test('GraphQL commit totals reject truncated collections and changes during pagination', async () => {
  for (const changed of [false, true]) {
    let calls = 0
    const pipeline = fixturePipeline((url, init) => {
      if (url.pathname !== '/graphql') return fixtureResponse(url, init)
      calls++
      return commitPage([{ ...commit, sha: String(calls).padStart(40, '0') }], changed && calls === 2 ? 3 : 2, changed && calls === 1 ? 'next' : null)
    })
    const journal = createMemoryJournal()
    const result = await runIngestion(request(pipeline, 'pull_request_commits'), { journal, destination: createMemoryDestination(), now: () => cutoff })
    expect(result.ok).toBe(false)
    expect(calls).toBe(changed ? 2 : 1)
    expect((await journal.readCheckpoint('github.pull_request_commits.obsessiondb.chkit')).lastSuccessSeq).toBe(0)
  }
})

test('GraphQL commits validate complete counts on empty terminal pages', async () => {
  for (const total of [0, 1, 2]) {
    let calls = 0
    const pipeline = fixturePipeline((url, init) => {
      if (url.pathname !== '/graphql') return fixtureResponse(url, init)
      calls++
      return commitPage(total > 0 && calls === 1 ? [commit] : [], total, total > 0 && calls === 1 ? 'terminal' : null)
    })
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    const result = await runIngestion(request(pipeline, 'pull_request_commits'), { journal, destination, now: () => cutoff })
    expect(result.ok).toBe(total < 2)
    expect(calls).toBe(total === 0 ? 1 : 2)
    expect((await journal.readCheckpoint('github.pull_request_commits.obsessiondb.chkit')).lastSuccessSeq > 0).toBe(total < 2)
    if (total < 2) expect(destination.tables.get('default.github_pull_request_commits_raw') ?? []).toHaveLength(total)
  }
})

test('GraphQL commit pagination rejects duplicate SHAs within or across pages despite a matching total', async () => {
  for (const acrossPages of [true, false]) {
    let calls = 0
    const pipeline = fixturePipeline((url, init) => {
      if (url.pathname !== '/graphql') return fixtureResponse(url, init)
      calls++
      return acrossPages ? commitPage([commit], 2, calls === 1 ? 'next' : null) : commitPage([commit, commit], 2, null)
    })
    const journal = createMemoryJournal()
    const result = await runIngestion(request(pipeline, 'pull_request_commits'), { journal, destination: createMemoryDestination(), now: () => cutoff })
    expect(result.ok).toBe(false)
    expect(calls).toBe(acrossPages ? 2 : 1)
    expect((await journal.readCheckpoint('github.pull_request_commits.obsessiondb.chkit')).lastSuccessSeq).toBe(0)
  }
})

test('GitHub binds configuration and preserves independently selected installation and repository progress', async () => {
  const requests: URL[] = []
  const config = { ...githubConfig, sourceId: 'github.fixture', repositories: ['first/repo', 'second/repo'], pageSize: 25, start: new Date('2025-01-01'), overlapMs: 60_000 }
  const pipeline = createGitHubPipeline(config, { token: () => 'bound-token', fetch: async (input, init) => {
    const url = new URL(input)
    requests.push(url)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer bound-token')
    expect(url.searchParams.get('per_page')).toBe('25')
    return Response.json([])
  } })
  config.pageSize = 100
  config.repositories.push('third/repo')
  config.start.setUTCFullYear(2000)
  config.overlapMs = 3_600_000
  expect(pipeline.streams.map((stream) => stream.id).sort()).toEqual(['first.repo', 'second.repo'].flatMap((repo) => resources.map((resource) => `github.fixture.${resource}.${repo}`)).sort())
  const journal = createMemoryJournal(), destination = createMemoryDestination()
  expect((await runIngestion(request(pipeline), { journal, destination, now: () => cutoff })).ok).toBe(true)
  expect(requests.filter((url) => url.searchParams.has('since')).every((url) => url.searchParams.get('since') === '2025-01-01T00:00:00.000Z')).toBe(true)
  requests.length = 0
  const selected = selectStreams([pipeline], ['repository:second/repo', 'resource:issues'])
  expect(selected.map((entry) => entry.stream.id)).toEqual(['github.fixture.issues.second.repo'])
  expect((await runIngestion({ selected, backfill: undefined }, { journal, destination, now: () => new Date('2026-01-03') })).ok).toBe(true)
  expect(requests.map((url) => url.pathname)).toEqual(['/repos/second/repo/issues'])
  expect(requests[0]?.searchParams.get('since')).toBe('2026-01-01T23:59:00.000Z')
  expect((await journal.readCheckpoint('github.issues.obsessiondb.chkit')).envelope).toBeUndefined()
})

test('GitHub paginated HTTP rate limits consume exactly one request retry budget', async () => {
  let attempts = 0
  const pipeline = fixturePipeline(() => ++attempts === 1
    ? new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '0' } }) : Response.json([]))
  const selected = request(pipeline, 'stargazers').selected.map((entry) => ({ ...entry, stream: { ...entry.stream, retry: { retries: 1, minTimeout: 0, maxTimeout: 0 } } }))
  const journal = createMemoryJournal()
  expect((await runIngestion({ selected, backfill: undefined }, { journal, destination: createMemoryDestination(), now: () => cutoff })).ok).toBe(true)
  expect(attempts).toBe(2)
  expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled' && event.errorClass === 'rate_limited')).toHaveLength(1)
})

test('GraphQL HTTP200 rate errors honor Retry-After while partial data fails permanently', async () => {
  for (const retryable of [true, false]) {
    let attempts = 0
    const pipeline = fixturePipeline((url, init) => {
      if (url.pathname !== '/graphql') return fixtureResponse(url, init)
      attempts++
      if (retryable && attempts > 1) return commitPage([commit], 1, null)
      return Response.json({ data: { repository: null }, errors: [{ type: retryable ? 'RATE_LIMITED' : 'NOT_FOUND', message: 'query rejected' }] },
        { headers: retryable ? { 'Retry-After': '0', 'x-ratelimit-remaining': '0' } : {} })
    })
    const selected = request(pipeline, 'pull_request_commits').selected.map((entry) => ({ ...entry, stream: { ...entry.stream, retry: { retries: 1, minTimeout: 0, maxTimeout: 0 } } }))
    const journal = createMemoryJournal()
    const result = await runIngestion({ selected, backfill: undefined }, { journal, destination: createMemoryDestination(), now: () => cutoff })
    expect(result.ok).toBe(retryable)
    expect(attempts).toBe(retryable ? 2 : 1)
    expect(journal.events.filter((event) => event.eventKind === 'retry_scheduled')).toHaveLength(retryable ? 1 : 0)
  }
})

test('secondary REST rate limits and headerless GraphQL rate errors retain provider diagnostics', async () => {
  const rest = await HttpError.fromResponse(Response.json({ message: 'You have exceeded a secondary rate limit.' },
    { status: 403, headers: { 'x-ratelimit-remaining': '19' } }))
  expect(rest.status).toBe(403)
  expect(rest.body).toContain('secondary rate limit')
  expect(classifyGitHubError(rest)).toEqual({ kind: 'rate_limited', retryAfterMs: 60_000 })
  const payload = { data: { repository: null }, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }
  const failure: unknown = await requestGitHubGraphql('query { viewer { login } }', {}, new AbortController().signal,
    { token: () => 'fixture', fetch: async () => Response.json(payload) }).catch((cause: unknown) => cause)
  expect(failure).toBeInstanceOf(HttpError)
  expect(failure).toMatchObject({ status: 200, body: JSON.stringify(payload) })
  expect(classifyGitHubError(failure)).toEqual({ kind: 'rate_limited', retryAfterMs: 60_000 })
})

test('invalid REST continuations and payloads fail without completing or replaying the resource', async () => {
  for (const mode of ['repeated', 'foreign', 'malformed']) {
    let calls = 0
    const pipeline = fixturePipeline((url) => {
      calls++
      return mode === 'malformed' ? Response.json({ not: 'an array' })
        : Response.json([stargazer], { headers: { Link: `<${mode === 'foreign' ? 'https://example.com/steal' : url.toString()}>; rel="next"` } })
    })
    const journal = createMemoryJournal(), destination = createMemoryDestination()
    const result = await runIngestion(request(pipeline, 'stargazers'), { journal, destination, now: () => cutoff })
    expect(result.ok).toBe(false)
    expect(calls).toBe(1)
    expect(destination.tables.size).toBe(0)
    expect((await journal.readCheckpoint('github.stargazers.obsessiondb.chkit')).lastSuccessSeq).toBe(0)
  }
})

test('GraphQL malformed or cyclic cursors and invalid commit nodes never record successful completion', async () => {
  for (const mode of ['missing-cursor', 'repeated', 'missing-message']) {
    let calls = 0
    const pipeline = fixturePipeline((url, init) => {
      if (url.pathname !== '/graphql') return fixtureResponse(url, init)
      calls++
      const page = { totalCount: mode === 'repeated' ? 3 : 1,
        nodes: [{ commit: mode === 'missing-message' ? { oid: commit.sha }
          : { oid: mode === 'repeated' ? String(calls).padStart(40, '0') : commit.sha, message: commit.message } }],
        pageInfo: { hasNextPage: mode !== 'missing-message', endCursor: mode === 'missing-cursor' ? null : 'same' } }
      return Response.json({ data: { repository: { pullRequest: { commits: page } } } })
    })
    const journal = createMemoryJournal()
    const result = await runIngestion(request(pipeline, 'pull_request_commits'), { journal, destination: createMemoryDestination(), now: () => cutoff })
    expect(result.ok).toBe(false)
    expect(calls).toBe(mode === 'repeated' ? 2 : 1)
    if (mode === 'repeated') expect(result.streams[0]?.error).toContain('repeated continuation')
    expect((await journal.readCheckpoint('github.pull_request_commits.obsessiondb.chkit')).lastSuccessSeq).toBe(0)
  }
})

test('review comments reject a parent URL from another repository before claiming a watermark', async () => {
  const pipeline = fixturePipeline(() => Response.json([{ ...reviewComment, pull_request_url: 'https://api.github.com/repos/another/project/pulls/2' }]))
  const journal = createMemoryJournal()
  const result = await runIngestion(request(pipeline, 'pull_request_review_comments'), { journal, destination: createMemoryDestination(), now: () => cutoff })
  expect(result.ok).toBe(false)
  expect((await journal.readCheckpoint('github.pull_request_review_comments.obsessiondb.chkit')).envelope).toBeUndefined()
})

function fixturePipeline(respond: Responder = fixtureResponse, config: GitHubConfig = githubConfig): Pipeline {
  return createGitHubPipeline(config, { token: () => 'fixture', fetch: (url, init) => Promise.resolve(respond(new URL(url), init)) })
}

function request(pipeline: Pipeline, resource?: string) {
  return { selected: selectStreams([pipeline], resource ? [`resource:${resource}`] : []).map((entry) => ({
    ...entry, stream: { ...entry.stream, batchSize: 1, retry: { retries: 0 } },
  })), backfill: undefined }
}

function fixtureResponse(url: URL, _init: RequestInit): Response {
  if (url.pathname === `/repos/${repository}/issues`) return Response.json([issue, pullIssue])
  if (url.pathname === `/repos/${repository}/pulls`) return Response.json([pull])
  if (url.pathname.endsWith('/issues/1/comments')) return Response.json([issueComment])
  if (url.pathname.endsWith('/issues/2/comments')) return Response.json([pullComment])
  if (url.pathname.endsWith('/pulls/comments')) return Response.json([reviewComment])
  if (url.pathname.endsWith('/pulls/2/reviews')) return Response.json([review])
  if (url.pathname.endsWith('/stargazers')) return Response.json([stargazer])
  if (url.pathname === '/graphql') return commitPage([commit], 1, null)
  throw new IngestConfigError(`Unexpected GitHub fixture request: ${url}`)
}

function commitPage(items: readonly { sha: string; message: string }[], totalCount: number, next: string | null): Response {
  return Response.json({ data: { repository: { pullRequest: { commits: { totalCount,
    nodes: items.map((item) => ({ commit: { oid: item.sha, message: item.message, author: { name: 'Do not retain expanded commit fields' } } })),
    pageInfo: { hasNextPage: next !== null, endCursor: next },
  } } } } })
}
