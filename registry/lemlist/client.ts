import { paginate, type Page, type SourceContext, type TimestampRange } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { lemlistReaderConfigSchema, type LemlistReaderConfig } from './config.js'

export type ListResource = 'activities' | 'campaigns' | 'contacts' | 'companies'
export type InboxScope = { userId: string } | { contactId: string }
export type LemlistItem = z.infer<typeof lemlistItem>
export type LemlistSettings = Omit<z.output<typeof lemlistReaderConfigSchema>, 'apiKey'>
export interface InboxCursor { page: number; skip: number }

export interface LemlistClient {
  settings: LemlistSettings
  list(resource: ListResource, window?: TimestampRange): AsyncGenerator<Page<LemlistItem, number>>
  inbox(scope: InboxScope): AsyncGenerator<Page<LemlistItem, InboxCursor>>
  contacts(ids: readonly string[]): Promise<LemlistItem[]>
  campaignLeads(campaignId: string): Promise<LemlistItem[]>
  teamUserIds(): Promise<string[]>
}

type Get = (path: string, params: Record<string, string>) => Promise<unknown>

const nonNegative = z.int().nonnegative()
const lemlistId = z.string().refine((value) => value.trim() !== '', 'must not be blank')
const lemlistItem = z.looseObject({ _id: lemlistId })
const lemlistItems = z.array(lemlistItem)
  .refine((items) => new Set(items.map((item) => item._id)).size === items.length, 'must not repeat an object ID')
// The public API returns arrays; retain compatibility with older campaign envelopes.
const campaignItems = z.union([lemlistItems, z.looseObject({ campaigns: lemlistItems }).transform(({ campaigns }) => campaigns)])
const offsetListing = z.looseObject({ data: lemlistItems, limit: z.int().positive(), total: nonNegative, offset: nonNegative })
const inboxListing = z.looseObject({
  data: lemlistItems,
  pagination: z.looseObject({ totalItems: nonNegative, perPage: z.int().positive(), currentPage: z.int().positive(), totalPages: nonNegative, nextPage: z.int().nullable() }),
})
const team = z.looseObject({ userIds: z.array(lemlistId).optional(), users: z.array(z.looseObject({ userId: lemlistId })).optional() })

export function createLemlistClient(context: SourceContext, config: LemlistReaderConfig): LemlistClient {
  const { apiKey, ...settings } = lemlistReaderConfigSchema.parse(config)
  const authorization = `Basic ${Buffer.from(`:${apiKey}`).toString('base64')}`
  const get: Get = async (path, params) => {
    const url = new URL(`https://api.lemlist.com/api${path}`)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    const response = await context.fetch(url, { headers: { Authorization: authorization }, redirect: 'error' })
    return response.json()
  }
  return {
    settings,
    list: (resource, window) => listPages(context, get, settings.pageSize, resource, window),
    inbox: (scope) => inboxPages(context, get, settings.pageSize, scope),
    contacts: async (ids) => {
      const items = lemlistItems.parse(await get('/contacts', { idsOrEmails: ids.join(',') }))
      const expected = new Set(ids)
      if (items.length !== ids.length || items.some((item) => !expected.has(item._id))) {
        throw new Error('Lemlist contact lookup did not return every discovered contact; replay this stream.')
      }
      return items
    },
    // The normal lead list has a 500-row cap and no continuation. This endpoint explicitly exports all states.
    campaignLeads: async (campaignId) => lemlistItems.parse(
      await get(`/v2/campaigns/${encodeURIComponent(campaignId)}/export/leads`, { state: 'all', format: 'json' }),
    ),
    teamUserIds: async () => {
      const members = team.parse(await get('/team', { version: 'v2' }))
      const ids = members.userIds ?? members.users?.map((user) => user.userId)
      if (!ids?.length) throw new Error('Lemlist team has no member IDs; configure inboxUserIds or restore team access.')
      return [...new Set(ids)]
    },
  }
}

/** Offsets are local traversal positions, never durable change cursors. */
function listPages(context: SourceContext, get: Get, pageSize: number, resource: ListResource, window: TimestampRange | undefined) {
  const seen = new Set<string>()
  return paginate({
    context, initial: 0, label: `GET /${resource}`,
    fetchPage: async (offset = 0) => {
      const params: Record<string, string> = { limit: String(pageSize), offset: String(offset) }
      if (resource === 'activities' || resource === 'campaigns') params.version = 'v2'
      if (window) {
        params.minDate = window.from.toISOString()
        params.maxDate = window.to.toISOString()
      } else if (resource !== 'contacts') {
        params.sortBy = 'createdAt'
        params.sortOrder = 'asc'
      }
      const result = await get(`/${resource}`, params)
      let items: LemlistItem[]
      let next: number | undefined
      if (resource === 'contacts' || resource === 'companies') {
        const listing = offsetListing.parse(result)
        items = listing.data
        if (listing.offset !== offset || listing.limit > pageSize || items.length > listing.limit ||
          offset + items.length > listing.total || (items.length < listing.limit && offset + items.length < listing.total)) {
          throw new Error(`Lemlist ${resource} has inconsistent pagination; replay this stream.`)
        }
        next = offset + items.length < listing.total ? offset + listing.limit : undefined
      } else {
        items = resource === 'campaigns' ? campaignItems.parse(result) : lemlistItems.parse(result)
        if (items.length > pageSize) throw new Error(`Lemlist ${resource} exceeds pageSize.`)
        next = items.length === pageSize ? offset + items.length : undefined
      }
      rejectRepeatedPage(items, seen, resource)
      if (next !== undefined && !Number.isSafeInteger(next)) throw new Error('Lemlist offset exceeded the safe integer range.')
      return { items, next }
    },
  })
}

/** Inbox pagination is page-based; the messages endpoint accepts the equivalent skip. */
function inboxPages(context: SourceContext, get: Get, pageSize: number, scope: InboxScope) {
  const path = 'userId' in scope ? '/inbox' : `/inbox/${encodeURIComponent(scope.contactId)}`
  const seen = new Set<string>()
  let expectedTotal: number | undefined
  let received = 0
  return paginate({
    context, initial: { page: 1, skip: 0 }, label: `GET ${path}`,
    fetchPage: async (cursor: InboxCursor = { page: 1, skip: 0 }) => {
      const params: Record<string, string> = { limit: String(pageSize) }
      if ('userId' in scope) {
        params.userId = scope.userId
        params.page = String(cursor.page)
      } else {
        params.skip = String(cursor.skip)
        params.markAsRead = 'false'
      }
      const { data: items, pagination } = inboxListing.parse(await get(path, params))
      const { totalItems: total, perPage, currentPage, totalPages, nextPage } = pagination
      if (currentPage !== cursor.page || perPage > pageSize || items.length > perPage ||
        (expectedTotal !== undefined && total !== expectedTotal) ||
        (nextPage !== null && (nextPage !== currentPage + 1 || items.length === 0 || currentPage >= totalPages)) ||
        (nextPage === null && totalPages > currentPage)) {
        throw new Error('Lemlist inbox has malformed or incomplete pagination; replay this stream.')
      }
      rejectRepeatedPage(items, seen, path)
      const count = received + items.length
      if (count > total || (nextPage === null && count !== total)) throw new Error('Lemlist inbox ended before its advertised complete collection.')
      expectedTotal = total
      received = count
      const next = nextPage === null ? undefined : { page: nextPage, skip: cursor.skip + perPage }
      return { items, next }
    },
  })
}

function rejectRepeatedPage(items: readonly LemlistItem[], seen: Set<string>, label: string) {
  if (items.some((item) => seen.has(item._id))) throw new Error(`Lemlist ${label} repeated a page or object ID; replay this stream.`)
  for (const item of items) seen.add(item._id)
}
