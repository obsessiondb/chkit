import { HttpError, paginate, rawRows, type ErrorClassifier, type Page, type RawRow, type SourceContext, type TimestampRange } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { githubConfigSchema, type GitHubConfig } from './config.js'

export type GitHubObject = Record<string, unknown>
export type GitHubParent = z.output<typeof githubParent>
export type GitHubSettings = Omit<z.output<typeof githubConfigSchema>, 'token'>
export interface PageOptions { accept?: string; params?: Record<string, string> }

export interface GitHubClient {
  settings: GitHubSettings
  pages<T extends GitHubObject>(path: string, item: z.ZodType<T>, options?: PageOptions): AsyncGenerator<Page<T, string>>
  /** An omitted window means complete parent discovery, independent of another stream's progress. */
  issues(repo: string, window?: TimestampRange): AsyncGenerator<Page<GitHubParent, string>>
  /** GitHub has no since filter for PR metadata: list the current collection in full. */
  pulls(repo: string): AsyncGenerator<Page<GitHubParent, string>>
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>
}

export const githubId = z.int().positive()
export const githubParent = z.looseObject({ number: githubId })
export const githubRecord = z.looseObject({ id: githubId })
const apiUrl = 'https://api.github.com'
const updated = z.looseObject({ updated_at: z.string().refine((value) => Number.isFinite(Date.parse(value)), 'must be a timestamp') })
const graphqlResponse = z.looseObject({
  data: z.unknown(),
  errors: z.array(z.looseObject({ type: z.string().optional(), message: z.string().optional() })).optional(),
})

export function createGitHubClient(context: SourceContext, config: GitHubConfig): GitHubClient {
  const { token, ...settings } = githubConfigSchema.parse(config)
  const request = (url: string, accept: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
    context.fetch(url, { ...init, redirect: 'error', headers: { ...init.headers, Authorization: `Bearer ${token}`, Accept: accept } })
  const pages = <T extends GitHubObject>(path: string, item: z.ZodType<T>, options: PageOptions = {}) => {
    const first = new URL(`${apiUrl}${path}`)
    for (const [key, value] of Object.entries({ ...options.params, per_page: String(settings.pageSize) })) first.searchParams.set(key, value)
    const page = z.array(item)
    return paginate<T, string>({
      context, initial: first.toString(), label: `GET ${path}`,
      fetchPage: async (cursor = first.toString()) => {
        const response = await request(cursor, options.accept ?? 'application/vnd.github+json', { headers: { 'X-GitHub-Api-Version': '2022-11-28' } })
        return { items: page.parse(await response.json()), next: nextLink(response.headers.get('link'), cursor) }
      },
    })
  }
  return {
    settings,
    pages,
    async *issues(repo, window) {
      for await (const page of pages(`/repos/${repo}/issues`, githubParent, { params: {
        state: 'all', sort: 'updated', direction: 'asc', ...(window ? { since: window.from.toISOString() } : {}),
      } })) {
        const issues = page.items.filter((item) => item.pull_request === undefined)
        yield { ...page, items: window ? updatedItems(issues, window) : issues }
      }
    },
    pulls: (repo) => pages(`/repos/${repo}/pulls`, githubParent, { params: { state: 'all', sort: 'updated', direction: 'asc' } }),
    graphql: async (query, variables) => {
      const response = await request(`${apiUrl}/graphql`, 'application/json', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }),
      })
      const body = graphqlResponse.parse(await response.clone().json())
      if (!body.errors?.length) return body.data
      const rateLimited = response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') ||
        body.errors.some((error) => error.type === 'RATE_LIMITED' || /secondary rate limit/i.test(error.message ?? ''))
      if (rateLimited) throw HttpError.withStatus(response, 429, { body: await response.clone().text() })
      throw new Error(`GitHub GraphQL returned errors: ${JSON.stringify(body.errors)}`)
    },
  }
}

/** GitHub signals rate exhaustion with 403 as well as 429. */
export function classifyGitHubError(cause: unknown): ReturnType<ErrorClassifier> {
  if (!(cause instanceof HttpError) || ![403, 429].includes(cause.status)) return undefined
  const headers = cause.response.headers
  const reportedRateLimit = /secondary rate limit/i.test(cause.body) || /"type"\s*:\s*"RATE_LIMITED"/.test(cause.body)
  if (headers.get('x-ratelimit-remaining') !== '0' && !headers.has('retry-after') && !reportedRateLimit) return undefined
  const resetSeconds = Number(headers.get('x-ratelimit-reset'))
  const untilReset = Number.isFinite(resetSeconds) && resetSeconds > 0 ? Math.max(0, resetSeconds * 1000 - Date.now()) : undefined
  return { kind: 'rate_limited', retryAfterMs: cause.retryAfterMs ?? untilReset ?? 60_000 }
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

export function updatedItems<T extends GitHubObject>(items: readonly T[], window: TimestampRange): T[] {
  return items.filter((item) => {
    const time = Date.parse(updated.parse(item).updated_at)
    return time >= window.from.getTime() && time <= window.to.getTime()
  })
}

export function pullNumber(pullRequestUrl: string, repo: string): number {
  if (!URL.canParse(pullRequestUrl)) throw new Error('GitHub review comment has an invalid pull_request_url.')
  const url = new URL(pullRequestUrl)
  const prefix = `/repos/${repo}/pulls/`
  const value = url.pathname.slice(prefix.length)
  if (url.origin !== apiUrl || !url.pathname.toLowerCase().startsWith(prefix.toLowerCase()) || !/^[1-9]\d*$/.test(value)) {
    throw new Error('GitHub review comment belongs to an unexpected repository or pull request.')
  }
  return githubId.parse(Number(value))
}

function nextLink(header: string | null, current: string): string | undefined {
  for (const link of header?.matchAll(/<([^>]*)>((?:[^",]|"(?:\\.|[^"\\])*")*)/g) ?? []) {
    const value = link[1]
    const parameters = link[2] ?? ''
    const relation = [...parameters.matchAll(/;\s*([^=;\s]+)\s*(?:=\s*("(?:\\.|[^"\\])*"|[^;\s]+))?/g)]
      .find((parameter) => parameter[1]?.toLowerCase() === 'rel')?.[2]
    if (value === undefined || !relation) continue
    const relations = relation.startsWith('"') ? relation.slice(1, -1).replace(/\\(.)/g, '$1') : relation
    if (!relations.toLowerCase().split(/\s+/).includes('next')) continue
    if (!URL.canParse(value, current)) throw new Error('GitHub next page has an invalid URL.')
    const next = new URL(value, current)
    if (next.origin !== apiUrl) throw new Error('GitHub next page has an unexpected origin.')
    return next.toString()
  }
  return undefined
}
