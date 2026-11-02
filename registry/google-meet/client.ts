import { HttpError, paginate, type Page, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { googleMeetReaderConfigSchema, type GoogleMeetReaderConfig } from './config.js'

export interface Named { name: string; [key: string]: unknown }
export interface CollectionCursor { pageToken?: string; recoveryCount?: number }
export interface CollectionOptions { filter?: string; initial?: CollectionCursor; pageSize?: number }
export type GoogleMeetSettings = Omit<z.output<typeof googleMeetReaderConfigSchema>, 'accessToken'>

export interface GoogleMeetClient {
  settings: GoogleMeetSettings
  collection(path: string, field: string, options?: CollectionOptions): AsyncGenerator<Page<Named, CollectionCursor, { reset: true }>>
}

const pageEnvelope = z.looseObject({ nextPageToken: z.string().min(1).optional() })
const resource = z.looseObject({ name: z.string().min(1) })

export function createGoogleMeetClient(context: SourceContext, config: GoogleMeetReaderConfig): GoogleMeetClient {
  const { accessToken, ...settings } = googleMeetReaderConfigSchema.parse(config)
  const get = (url: URL) => context.fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error' })
  return {
    settings,
    collection: (path, field, options = {}) => paginate<Named, CollectionCursor, { reset: true }>({
      context, initial: options.initial ?? {}, label: `GET ${field}`,
      fetchPage: async (cursor) => {
        const current = cursor ?? {}
        const page = await requestPage(get, path, field, current.pageToken, options)
        if ('reset' in page) {
          if (current.recoveryCount) throw new Error(`Meet ${field} repeatedly rejected its page token. Increase the execution budget or migrate the checkpoint after reviewing coverage.`)
          return { items: [], next: { recoveryCount: 1 }, metadata: { reset: true } }
        }
        return { items: page.items, next: page.nextPageToken ? { ...current, pageToken: page.nextPageToken } : undefined }
      },
    }),
  }
}

async function requestPage(get: (url: URL) => Promise<Response>, path: string, field: string, pageToken: string | undefined, options: CollectionOptions): Promise<{ items: Named[]; nextPageToken?: string } | { reset: true }> {
  const pageSize = options.pageSize ?? 100
  const url = new URL(`https://meet.googleapis.com/v2/${path}`)
  url.searchParams.set('pageSize', String(pageSize))
  if (options.filter) url.searchParams.set('filter', options.filter)
  if (pageToken) url.searchParams.set('pageToken', pageToken)
  let response: Response
  try {
    response = await get(url)
  } catch (error) {
    if (pageToken && isRejectedPageToken(error)) return { reset: true }
    throw error
  }
  const payload = pageEnvelope.parse(await response.json())
  const items = z.array(resource).max(pageSize).optional().parse(payload[field]) ?? []
  for (const item of items) {
    const child = item.name.slice(path.length + 1)
    const inside = field === 'conferenceRecords'
      ? /^conferenceRecords\/[^/?#]+$/.test(item.name)
      : item.name.startsWith(`${path}/`) && !child.includes('/') && !/[?#]/.test(child)
    if (!inside) throw new Error(`Meet ${field} returned a resource outside its requested parent.`)
  }
  return { items, nextPageToken: payload.nextPageToken }
}

function isRejectedPageToken(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 400 || error.status === 410)
    && /page[_\s-]*token/i.test(error.body) && /invalid|expir/i.test(error.body)
}
