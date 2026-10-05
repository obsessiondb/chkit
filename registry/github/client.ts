import { HttpError, IngestConfigError, paginate, rawRows, type ErrorClassifier, type FetchContext, type RawRow, type TimestampRange } from '@chkit/plugin-ingest'

import type { GitHubConfig } from './config.js'

export type GitHubObject = Record<string, unknown>

export interface GitHubClientDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string | undefined
}

export const defaultGitHubClientDeps: GitHubClientDeps = {
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.GITHUB_TOKEN,
}

/** Each page has one executor-owned request attempt; cursors remain local to this read. */
export function readGitHubPages(
  context: FetchContext,
  input: { path: string; accept?: string; params?: Record<string, string> },
  config: GitHubConfig,
  deps: GitHubClientDeps,
) {
  const first = new URL(`https://api.github.com${input.path}`)
  for (const [key, value] of Object.entries({ ...input.params, per_page: String(config.pageSize) })) first.searchParams.set(key, value)
  return paginate<GitHubObject, string>({
    context, initial: first.toString(), label: `GET ${input.path}`,
    fetchPage: async (cursor = first.toString(), signal) => {
      const response = await requestGitHub(cursor, input.accept, signal, deps)
      const payload: unknown = await response.json()
      if (!Array.isArray(payload)) throw new IngestConfigError(`GitHub ${input.path} response is not an array.`)
      const items = payload.map((item: unknown) => requireGitHubObject(item, input.path))
      const next = nextLink(response.headers.get('link'), cursor)
      if (next === cursor) throw new IngestConfigError('GitHub repeated a page URL.')
      return { items, next }
    },
  })
}

/** An omitted window means complete parent discovery, independent of another stream's progress. */
export async function* readIssuePages(context: FetchContext, repo: string, config: GitHubConfig, deps: GitHubClientDeps, window?: TimestampRange) {
  for await (const page of readGitHubPages(context, { path: `/repos/${repo}/issues`, params: {
    state: 'all', sort: 'updated', direction: 'asc', ...(window ? { since: window.from.toISOString() } : {}),
  } }, config, deps)) {
    const issues = page.items.filter((item) => {
      githubNumber(item, 'number')
      if (item.pull_request !== undefined) return false
      return window === undefined || updatedItems([item], window).length > 0
    })
    yield { ...page, items: issues }
  }
}

/** GitHub has no since filter for PR metadata: list the current collection in full. */
export async function* readPullPages(context: FetchContext, repo: string, config: GitHubConfig, deps: GitHubClientDeps) {
  for await (const page of readGitHubPages(context, { path: `/repos/${repo}/pulls`, params: { state: 'all', sort: 'updated', direction: 'asc' } }, config, deps)) {
    for (const pull of page.items) githubNumber(pull, 'number')
    yield page
  }
}

/** Provider data stays intact; repository and parent keys live outside it for warehouse joins. */
export function toGitHubRows<T extends GitHubObject>(
  items: readonly T[], repo: string, identify: (item: T) => string | number,
  parent?: { issue_number: number } | { pull_number: number },
): RawRow[] {
  const number = parent && ('pull_number' in parent ? parent.pull_number : parent.issue_number)
  return rawRows(items.map((data) => ({ repository: repo, ...parent, data })), ({ data }) =>
    JSON.stringify([repo, ...(number === undefined ? [] : [number]), identify(data)]))
}

export function updatedItems(items: readonly GitHubObject[], window: TimestampRange): GitHubObject[] {
  return items.filter((item) => {
    if (typeof item.updated_at !== 'string' || !Number.isFinite(Date.parse(item.updated_at))) throw new IngestConfigError('GitHub object has no valid updated_at.')
    const updated = Date.parse(item.updated_at)
    return updated >= window.from.getTime() && updated <= window.to.getTime()
  })
}

export function githubNumber(item: GitHubObject, field: string): number {
  const value = item[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new IngestConfigError(`GitHub object has no valid ${field}.`)
  return value
}

export function pullNumber(item: GitHubObject, repo: string): number {
  if (typeof item.pull_request_url !== 'string') throw new IngestConfigError('GitHub review comment has no pull_request_url.')
  if (!URL.canParse(item.pull_request_url)) throw new IngestConfigError('GitHub review comment has an invalid pull_request_url.')
  const url = new URL(item.pull_request_url)
  const prefix = `/repos/${repo}/pulls/`
  const value = url.pathname.slice(prefix.length)
  if (url.origin !== 'https://api.github.com' || !url.pathname.toLowerCase().startsWith(prefix.toLowerCase()) || !/^[1-9]\d*$/.test(value)) {
    throw new IngestConfigError('GitHub review comment belongs to an unexpected repository or pull request.')
  }
  return githubNumber({ number: Number(value) }, 'number')
}

export function requireGitHubObject(value: unknown, label: string): GitHubObject {
  if (!isGitHubObject(value)) throw new IngestConfigError(`GitHub ${label} is not an object.`)
  return value
}

/** paginate wraps each GraphQL page; never nest another executor attempt here. */
export async function requestGitHubGraphql(query: string, variables: Record<string, unknown>, signal: AbortSignal, deps: GitHubClientDeps): Promise<GitHubObject> {
  const response = await deps.fetch('https://api.github.com/graphql', {
    method: 'POST', headers: { ...authorization(deps), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
  })
  if (!response.ok) throw await HttpError.fromResponse(response)
  const body = requireGitHubObject(await response.clone().json(), 'GraphQL response')
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const rateLimited = response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') ||
      body.errors.some((error: unknown) => isGitHubObject(error) &&
        (error.type === 'RATE_LIMITED' || (typeof error.message === 'string' && /secondary rate limit/i.test(error.message))))
    if (rateLimited) throw await HttpError.fromResponse(response)
    throw new IngestConfigError(`GitHub GraphQL returned errors: ${JSON.stringify(body.errors)}`)
  }
  if (body.errors !== undefined && !Array.isArray(body.errors)) throw new IngestConfigError('GitHub GraphQL errors is not an array.')
  return requireGitHubObject(body.data, 'GraphQL data')
}

/** REST 403 and GraphQL 200 can both signal rate exhaustion. */
export function classifyGitHubError(cause: unknown): ReturnType<ErrorClassifier> {
  if (cause instanceof SyntaxError) return { kind: 'permanent' }
  if (!(cause instanceof HttpError) || ![200, 403, 429].includes(cause.status)) return undefined
  const headers = cause.response.headers
  const reportedRateLimit = /secondary rate limit/i.test(cause.body) ||
    (cause.status === 200 && /"type"\s*:\s*"RATE_LIMITED"/.test(cause.body))
  if (headers.get('x-ratelimit-remaining') !== '0' && !headers.has('retry-after') && !reportedRateLimit) return undefined
  const resetSeconds = Number(headers.get('x-ratelimit-reset'))
  const untilReset = Number.isFinite(resetSeconds) && resetSeconds > 0 ? Math.max(0, resetSeconds * 1000 - Date.now()) : undefined
  return { kind: 'rate_limited', retryAfterMs: cause.retryAfterMs ?? untilReset ?? 60_000 }
}

async function requestGitHub(url: string, accept = 'application/vnd.github+json', signal: AbortSignal, deps: GitHubClientDeps): Promise<Response> {
  const response = await deps.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    headers: { ...authorization(deps), Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' } })
  if (!response.ok) throw await HttpError.fromResponse(response)
  return response
}

function authorization(deps: GitHubClientDeps): { Authorization: string } {
  const token = deps.token()?.trim()
  if (!token) throw new IngestConfigError('Set GITHUB_TOKEN.')
  return { Authorization: `Bearer ${token}` }
}

function isGitHubObject(value: unknown): value is GitHubObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nextLink(header: string | null, current: string): string | undefined {
  const value = header?.split(',').map((part) => /<([^>]+)>\s*;.*rel="?next"?/.exec(part)?.[1]).find(Boolean)
  if (!value) return undefined
  const next = new URL(value, current)
  if (next.origin !== 'https://api.github.com') throw new IngestConfigError('GitHub next page has an unexpected origin.')
  return next.toString()
}
