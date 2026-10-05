import { HttpError, IngestConfigError, type ErrorClassifier } from '@chkit/plugin-ingest'

export interface LinearClientDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string | undefined
}

export const defaultLinearClientDeps: LinearClientDeps = {
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.LINEAR_API_KEY,
}

/** paginate supplies the executor attempt for each GraphQL page. */
export async function graphql<T>(document: string, variables: Record<string, unknown>, signal: AbortSignal, deps: LinearClientDeps): Promise<T> {
  const token = deps.token()?.trim()
  if (!token) throw new IngestConfigError('Set LINEAR_API_KEY.')
  const response = await deps.fetch('https://api.linear.app/graphql', {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: document, variables }),
  })
  if (!response.ok) throw await HttpError.fromResponse(response)
  return await response.json() as T
}

/** Linear reports GraphQL rate exhaustion as HTTP 400 rather than 429. */
export function classifyLinearError(cause: unknown): ReturnType<ErrorClassifier> {
  if (!(cause instanceof HttpError) || cause.status !== 400 || !/"code"\s*:\s*"RATELIMITED"/.test(cause.body)) return undefined
  const headers = cause.response.headers
  const resets = ['requests', 'endpoint-requests', 'complexity'].flatMap((kind) => {
    if (headers.get(`x-ratelimit-${kind}-remaining`) !== '0') return []
    const reset = Number(headers.get(`x-ratelimit-${kind}-reset`))
    return Number.isFinite(reset) && reset > 0 ? [Math.max(0, reset - Date.now())] : []
  })
  return { kind: 'rate_limited', retryAfterMs: cause.retryAfterMs ?? (resets.length ? Math.max(...resets) : undefined) }
}
