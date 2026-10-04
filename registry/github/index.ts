import { definePipeline, defineStream, HttpError, IngestConfigError, rawRows, rawTable, timestampWindow, type ErrorClassifier, type FetchContext, type IncrementalStrategy } from '@chkit/plugin-ingest'

const database = 'default'
// One stable stream per repository. Reset its checkpoint when changing its scope.
const repositories = ['obsessiondb/chkit']
const overlapMs = 5 * 60 * 1000

interface Issue { number: number; updated_at: string; pull_request?: { url: string }; [key: string]: unknown }
interface Stargazer { user: { id: number }; [key: string]: unknown }
interface ScanState { completedAt: string }

export const github_issuesRaw = rawTable({ database, name: 'github_issues_raw' })
export const github_stargazersRaw = rawTable({ database, name: 'github_stargazers_raw' })

const stargazerScan: IncrementalStrategy<ScanState, string> = {
  id: 'github.stargazers.full_scan', version: 1,
  parseState(raw) {
    if (!isObject(raw) || typeof raw.completedAt !== 'string' || !Number.isFinite(Date.parse(raw.completedAt))) {
      throw new IngestConfigError('GitHub stargazer checkpoint has no valid completedAt.')
    }
    return { completedAt: raw.completedAt }
  },
  plan: ({ cutoff }) => cutoff.toISOString(),
  complete: ({ selection }) => ({ completedAt: selection }),
}

export const githubPipeline = definePipeline({
  id: 'github', tags: ['provider:github'], maxStreams: 1, maxFetches: 1,
  streams: repositories.flatMap((repo) => [
    defineStream({
      id: `github.issues.${repo.replace('/', '.')}`, tags: ['resource:issues'], destination: github_issuesRaw,
      // GitHub's since filter is strict; overlap includes equal timestamps and recent changes.
      incremental: timestampWindow({ start: new Date('2008-01-01T00:00:00Z'), overlapMs }),
      classifyError: classifyGitHubError,
      async *read(context) {
        for await (const page of pages<Issue>(context, `/repos/${repo}/issues`, 'application/vnd.github+json', {
          state: 'all', sort: 'updated', direction: 'asc', since: context.selection.from.toISOString(),
        })) {
          for (const issue of page) {
            if (!Number.isSafeInteger(issue.number) || !Number.isFinite(Date.parse(issue.updated_at))) {
              throw new IngestConfigError('GitHub issue has no valid number or updated_at.')
            }
            // REST has no until parameter. Enforce the cutoff locally; live pages are not snapshots.
            if (Date.parse(issue.updated_at) > context.selection.to.getTime()) continue
            const complete = await withIssueContext(context, repo, issue)
            yield { rows: rawRows([complete], (item) => JSON.stringify([repo, item.number])) }
          }
        }
      },
    }),
    defineStream({
      id: `github.stargazers.${repo.replace('/', '.')}`, tags: ['resource:stargazers'], destination: github_stargazersRaw,
      incremental: stargazerScan, classifyError: classifyGitHubError,
      async *read(context) {
        for await (const page of pages<Stargazer>(context, `/repos/${repo}/stargazers`, 'application/vnd.github.star+json')) {
          if (page.some((star) => !star.user || !Number.isSafeInteger(star.user.id))) throw new IngestConfigError('GitHub stargazer has no user ID.')
          yield { rows: rawRows(page, (star) => JSON.stringify([repo, star.user.id])) }
        }
      },
    }),
  ]),
})

/** A 403 can mean rate exhaustion; ordinary permission failures remain permanent. */
function classifyGitHubError(cause: unknown): ReturnType<ErrorClassifier> {
  if (!(cause instanceof HttpError) || (cause.status !== 403 && cause.status !== 429)) return undefined
  const headers = cause.response.headers
  if (headers.get('x-ratelimit-remaining') !== '0' && !headers.has('retry-after')) return undefined
  const resetSeconds = Number(headers.get('x-ratelimit-reset'))
  const untilReset = Number.isFinite(resetSeconds) && resetSeconds > 0 ? Math.max(0, resetSeconds * 1000 - Date.now()) : undefined
  return { kind: 'rate_limited', retryAfterMs: cause.retryAfterMs ?? untilReset }
}

async function* pages<T>(context: FetchContext, path: string, accept: string, params: Record<string, string> = {}): AsyncGenerator<T[]> {
  const first = new URL(`https://api.github.com${path}`)
  for (const [key, value] of Object.entries({ ...params, per_page: '100' })) first.searchParams.set(key, value)
  let next: string | undefined = first.toString()
  const seen = new Set<string>()
  while (next) {
    if (seen.has(next)) throw new IngestConfigError('GitHub repeated a page URL.')
    seen.add(next)
    const current: string = next
    const result = await context.attempt(async (signal) => {
      const response = await request(current, accept, signal)
      const items: unknown = await response.json()
      if (!Array.isArray(items)) throw new IngestConfigError(`GitHub ${path} response is not an array.`)
      return { items: items as T[], next: nextLink(response.headers.get('link'), current) }
    }, { label: `GET ${path}` })
    if (result.items.length) yield result.items
    next = result.next
  }
}

/** Load complete child conversations before publishing the parent observation. */
async function withIssueContext(context: FetchContext, repo: string, issue: Issue) {
  const comment_items = await collect(context, `/repos/${repo}/issues/${issue.number}/comments`)
  if (!issue.pull_request) return { ...issue, comment_items }
  const path = `/repos/${repo}/pulls/${issue.number}`
  const pull_detail = await context.attempt(async (signal) => {
    const response = await request(`https://api.github.com${path}`, 'application/vnd.github+json', signal)
    const detail: unknown = await response.json()
    if (!isObject(detail)) throw new IngestConfigError('GitHub pull request detail is not an object.')
    return detail
  }, { label: 'GET pull request detail' })
  const reviews = await collect(context, `${path}/reviews`)
  const review_comments = await collect(context, `${path}/comments`)
  const commits = await collect(context, `${path}/commits`)
  const files = await collect(context, `${path}/files`)
  return { ...issue, pull_detail, comment_items, reviews, review_comments, commits, files,
    _chkit_context: { files_complete: files.length === pull_detail.changed_files, commits_complete: commits.length === pull_detail.commits } }
}

async function collect(context: FetchContext, path: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  for await (const page of pages<Record<string, unknown>>(context, path, 'application/vnd.github+json')) items.push(...page)
  return items
}

async function request(url: string, accept: string, signal: AbortSignal): Promise<Response> {
  const token = process.env.GITHUB_TOKEN?.trim()
  if (!token) throw new IngestConfigError('Set GITHUB_TOKEN.')
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' } })
  if (!response.ok) throw await HttpError.fromResponse(response)
  return response
}

function nextLink(header: string | null, current: string): string | undefined {
  const value = header?.split(',').map((part) => /<([^>]+)>\s*;.*rel="?next"?/.exec(part)?.[1]).find(Boolean)
  if (!value) return undefined
  const next = new URL(value, current)
  if (next.origin !== 'https://api.github.com') throw new IngestConfigError('GitHub next page has an unexpected origin.')
  return next.toString()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
