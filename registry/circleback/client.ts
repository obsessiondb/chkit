import { HttpError, IngestConfigError, paginate, type FetchContext } from '@chkit/plugin-ingest'

import { circlebackConfig, type CirclebackReaderConfig } from './config.js'

const baseUrl = 'https://circleback.ai/api'

interface Meeting { id: string; [key: string]: unknown }

export interface CirclebackClientDeps {
  config: CirclebackReaderConfig
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string | undefined
}

export const defaultCirclebackClientDeps: CirclebackClientDeps = {
  config: circlebackConfig,
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.CIRCLEBACK_API_KEY,
}

export function readMeetingPages(context: FetchContext, deps: CirclebackClientDeps) {
  return paginate({
    context, initial: `${baseUrl}/meetings?ownership=${encodeURIComponent(deps.config.ownership)}`, label: 'GET /meetings',
    fetchPage: async (cursor, signal) => {
      if (!cursor) throw new IngestConfigError('Circleback meeting page URL is missing.')
      const response = await request(cursor, signal, deps)
      const items: unknown = await response.json()
      if (!Array.isArray(items) || !items.every(isMeeting)) throw new IngestConfigError('Circleback returned invalid meetings.')
      return { items, next: nextLink(response.headers.get('link'), cursor) }
    },
  })
}

export async function readTranscript(id: string, signal: AbortSignal, deps: CirclebackClientDeps) {
  const response = await request(`${baseUrl}/meeting/${encodeURIComponent(id)}/transcript`, signal, deps, true)
  if (response.status === 403) return { transcript: null, status: 'forbidden' as const }
  if (response.status === 404) return { transcript: null, status: 'not_found' as const }
  return { transcript: await response.json(), status: 'available' as const }
}

async function request(url: string, signal: AbortSignal, deps: CirclebackClientDeps, allowUnavailable = false): Promise<Response> {
  const token = deps.token()?.trim()
  if (!token) throw new IngestConfigError('Set CIRCLEBACK_API_KEY.')
  const response = await deps.fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (allowUnavailable && (response.status === 403 || response.status === 404)) return response
  if (!response.ok) throw await HttpError.fromResponse(response)
  return response
}

function nextLink(header: string | null, current: string): string | undefined {
  const value = header?.split(',').map((part) => /<([^>]+)>\s*;.*rel="?next"?/.exec(part)?.[1]).find(Boolean)
  if (!value) return undefined
  const next = new URL(value, current)
  if (next.origin !== 'https://circleback.ai') throw new IngestConfigError('Circleback next page has an unexpected origin.')
  return next.toString()
}

function isMeeting(value: unknown): value is Meeting {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && value.id.length > 0
}
