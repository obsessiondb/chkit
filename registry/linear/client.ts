import { HttpError, IngestConfigError, type ErrorClassifier } from '@chkit/plugin-ingest'

export type LinearObject = Record<string, unknown>

export interface LinearClientDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string | undefined
}

export const defaultLinearClientDeps: LinearClientDeps = {
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.LINEAR_API_KEY,
}

/** paginate supplies the executor attempt for each GraphQL page. */
export async function graphql(document: string, variables: Record<string, unknown>, signal: AbortSignal, deps: LinearClientDeps): Promise<LinearObject> {
  const token = deps.token()?.trim()
  if (!token) throw new IngestConfigError('Set LINEAR_API_KEY.')
  const response = await deps.fetch('https://api.linear.app/graphql', {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: document, variables }),
  })
  if (!response.ok) throw await HttpError.fromResponse(response)
  const body = requireLinearObject(await response.clone().json(), 'GraphQL response')
  if (body.errors !== undefined && !Array.isArray(body.errors)) throw new IngestConfigError('Linear GraphQL errors is not an array.')
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const rateLimited = body.errors.some((error: unknown) => isLinearObject(error) &&
      isLinearObject(error.extensions) && error.extensions.code === 'RATELIMITED')
    if (rateLimited) throw await HttpError.fromResponse(response)
    throw new IngestConfigError(`Linear GraphQL returned errors: ${JSON.stringify(body.errors)}`)
  }
  return requireLinearObject(body.data, 'GraphQL data')
}

/** Linear documents HTTP 400 rate errors; preserve GraphQL 200 rate errors too. */
export function classifyLinearError(cause: unknown): ReturnType<ErrorClassifier> {
  if (cause instanceof SyntaxError) return { kind: 'permanent' }
  if (!(cause instanceof HttpError) || ![200, 400].includes(cause.status) || !/"code"\s*:\s*"RATELIMITED"/.test(cause.body)) return undefined
  const headers = cause.response.headers
  const resets = ['requests', 'endpoint-requests', 'complexity'].flatMap((kind) => {
    if (headers.get(`x-ratelimit-${kind}-remaining`) !== '0') return []
    const reset = Number(headers.get(`x-ratelimit-${kind}-reset`))
    return Number.isFinite(reset) && reset > 0 ? [Math.max(0, reset - Date.now())] : []
  })
  return { kind: 'rate_limited', retryAfterMs: cause.retryAfterMs ?? (resets.length ? Math.max(...resets) : undefined) }
}

export function requireLinearObject(value: unknown, label: string): LinearObject {
  if (!isLinearObject(value)) throw new IngestConfigError(`Linear ${label} is not an object.`)
  return value
}

function isLinearObject(value: unknown): value is LinearObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
