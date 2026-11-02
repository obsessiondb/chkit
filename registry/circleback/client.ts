import { HttpError, paginate, rawRows, type ErrorClassifier, type Page, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { circlebackReaderConfigSchema, type CirclebackReaderConfig } from './config.js'

export type CirclebackObject = Record<string, unknown>
export type CirclebackCollection = '/meetings' | '/action-items' | '/people' | '/companies'
export type CirclebackSettings = Omit<z.output<typeof circlebackReaderConfigSchema>, 'apiKey'>
export type TranscriptRead =
  | { status: 'available'; data: z.output<typeof transcriptSegments> }
  | { status: 'forbidden' | 'not_found'; data: null }

export interface CirclebackClient {
  settings: CirclebackSettings
  pages<T extends CirclebackObject>(path: CirclebackCollection, item: z.ZodType<T>, query?: Record<string, string>): AsyncGenerator<Page<T, string>>
  detail<T extends CirclebackObject>(path: string, item: z.ZodType<T>): Promise<T>
  transcript(meetingId: string): Promise<TranscriptRead>
}

export const circlebackId = z.int().positive()
export const nonBlankString = z.string().refine((value) => value.trim() !== '', 'must not be blank')
/** Tag names are the requested projection; provider objects otherwise stay intact. */
export const circlebackTags = z.array(z.looseObject({ name: nonBlankString })).transform((tags) => tags.map((tag) => tag.name)).optional()
const baseUrl = 'https://circleback.ai/api'
const transcriptSegments = z.array(z.looseObject({ speaker: z.string().nullable(), text: z.string(), timestamp: z.number() }))
const unavailable = new Map<number, 'forbidden' | 'not_found'>([[403, 'forbidden'], [404, 'not_found']])

export function createCirclebackClient(context: SourceContext, config: CirclebackReaderConfig): CirclebackClient {
  const { apiKey, ...settings } = circlebackReaderConfigSchema.parse(config)
  const get = (url: string) => context.fetch(url, { redirect: 'error', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } })
  return {
    settings,
    pages<T extends CirclebackObject>(path: CirclebackCollection, item: z.ZodType<T>, query: Record<string, string> = {}) {
      const initial = new URL(`${baseUrl}${path}`)
      for (const [key, value] of Object.entries(query)) initial.searchParams.set(key, value)
      const page = z.array(item)
      return paginate<T, string>({
        context, initial: initial.toString(), label: `GET ${path}`,
        fetchPage: async (url = initial.toString()) => {
          const response = await get(url)
          return { items: page.parse(await response.json()), next: nextLink(response.headers.get('link'), url, query) }
        },
      })
    },
    async detail<T extends CirclebackObject>(path: string, item: z.ZodType<T>) {
      const response = await get(`${baseUrl}${path}`)
      return item.parse(await response.json())
    },
    async transcript(meetingId: string) {
      let response: Response
      try {
        response = await get(`${baseUrl}/meeting/${encodeURIComponent(meetingId)}/transcript`)
      } catch (error) {
        const status = error instanceof HttpError ? unavailable.get(error.status) : undefined
        if (status) return { status, data: null }
        throw error
      }
      return { status: 'available', data: transcriptSegments.parse(await response.json()) }
    },
  }
}

export function classifyCirclebackError(cause: unknown): ReturnType<ErrorClassifier> {
  if (!(cause instanceof HttpError) || cause.status !== 429) return undefined
  const reset = cause.response.headers.get('ratelimit-reset')
  const resetMs = reset?.trim() ? Number(reset) * 1000 : Number.NaN
  return { kind: 'rate_limited', retryAfterMs: cause.retryAfterMs ?? (Number.isFinite(resetMs) && resetMs >= 0 ? resetMs : undefined) }
}

export function toCirclebackRows<T extends CirclebackObject>(items: readonly T[], id: (item: T) => string | number, sourceId: string) {
  return rawRows(items.map((data) => ({ source_id: sourceId, data })), (item) => JSON.stringify([sourceId, id(item.data)]))
}

function nextLink(header: string | null, current: string, query: Record<string, string>): string | undefined {
  if (!header?.trim()) return undefined
  const candidates: string[] = []
  for (const part of header.split(/,(?=\s*<)/)) {
    const link = /^\s*<([^>]+)>\s*(.*)$/.exec(part)
    if (!link) throw new Error('Circleback returned a malformed Link header.')
    const relation = /;\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/.exec(link[2] ?? '')
    if (!(relation?.[1] ?? relation?.[2])?.split(/\s+/).includes('next')) continue
    if (!link[1]) throw new Error('Circleback next page URL is missing.')
    candidates.push(link[1])
  }
  if (candidates.length > 1) throw new Error('Circleback returned multiple next pages.')
  const value = candidates[0]
  if (!value) return undefined
  if (!URL.canParse(value, current)) throw new Error('Circleback returned an invalid next page URL.')
  const next = new URL(value, current)
  if (next.origin !== 'https://circleback.ai' || next.pathname !== new URL(current).pathname || next.username || next.password || next.hash) {
    throw new Error('Circleback next page changed the collection or origin.')
  }
  for (const [key, value] of Object.entries(query)) {
    const values = next.searchParams.getAll(key)
    if (values.length > 1 || values.some((nextValue) => nextValue !== value)) {
      throw new Error(`Circleback next page changed the ${key} filter.`)
    }
    next.searchParams.set(key, value)
  }
  return next.toString()
}
