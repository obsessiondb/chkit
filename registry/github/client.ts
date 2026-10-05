import { HttpError, IngestConfigError, paginate, type ErrorClassifier, type FetchContext } from '@chkit/plugin-ingest'

import type { GitHubConfig } from './config.js'

export interface GitHubClientDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string | undefined
}

export const defaultGitHubClientDeps: GitHubClientDeps = {
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.GITHUB_TOKEN,
}

export function readGitHubPages<T>(
  context: FetchContext,
  input: { path: string; accept?: string; params?: Record<string, string> },
  config: GitHubConfig,
  deps: GitHubClientDeps,
) {
  const first = new URL(`https://api.github.com${input.path}`)
  for (const [key, value] of Object.entries({ ...input.params, per_page: String(config.pageSize) })) first.searchParams.set(key, value)
  return paginate<T, string>({
    context, initial: first.toString(), label: `GET ${input.path}`,
    fetchPage: async (cursor = first.toString(), signal) => {
      const response = await requestGitHub(cursor, input.accept, signal, deps)
      const items: unknown = await response.json()
      if (!Array.isArray(items)) throw new IngestConfigError(`GitHub ${input.path} response is not an array.`)
      const next = nextLink(response.headers.get('link'), cursor)
      if (next === cursor) throw new IngestConfigError('GitHub repeated a page URL.')
      return { items: items as T[], next }
    },
  })
}

export async function requestGitHub(url: string, accept = 'application/vnd.github+json', signal: AbortSignal, deps: GitHubClientDeps): Promise<Response> {
  const token = deps.token()?.trim()
  if (!token) throw new IngestConfigError('Set GITHUB_TOKEN.')
  const response = await deps.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' } })
  if (!response.ok) throw await HttpError.fromResponse(response)
  return response
}

/** A 403 can mean rate exhaustion; ordinary permission failures remain permanent. */
export function classifyGitHubError(cause: unknown): ReturnType<ErrorClassifier> {
  if (!(cause instanceof HttpError) || (cause.status !== 403 && cause.status !== 429)) return undefined
  const headers = cause.response.headers
  if (headers.get('x-ratelimit-remaining') !== '0' && !headers.has('retry-after')) return undefined
  const resetSeconds = Number(headers.get('x-ratelimit-reset'))
  const untilReset = Number.isFinite(resetSeconds) && resetSeconds > 0 ? Math.max(0, resetSeconds * 1000 - Date.now()) : undefined
  return { kind: 'rate_limited', retryAfterMs: cause.retryAfterMs ?? untilReset }
}

function nextLink(header: string | null, current: string): string | undefined {
  const value = header?.split(',').map((part) => /<([^>]+)>\s*;.*rel="?next"?/.exec(part)?.[1]).find(Boolean)
  if (!value) return undefined
  const next = new URL(value, current)
  if (next.origin !== 'https://api.github.com') throw new IngestConfigError('GitHub next page has an unexpected origin.')
  return next.toString()
}
