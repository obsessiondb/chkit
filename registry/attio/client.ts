
import { HttpError, paginate, type Page, type SourceContext } from '@chkit/plugin-ingest'
import { z } from 'zod'

import { attioReaderConfigSchema, type AttioReaderConfig } from './config.js'

export type AttioEntity = Record<string, unknown> & { id: Record<string, string> }
export type AttioSettings = Omit<z.output<typeof attioReaderConfigSchema>, 'apiToken'>

export interface AttioParent {
  workspaceId: string
  id: string
  slug: string
}

export interface CollectionRequest {
  path: string
  idFields: readonly string[]
  method?: 'GET' | 'POST'
  body?: Record<string, unknown>
  query?: Record<string, string>
  /** Omit for the unpaginated objects, lists, and workspace_members endpoints. */
  pageSize?: number
  valuesField?: 'values' | 'entry_values'
  parent?: { field: 'object_id' | 'list_id'; id: string; workspaceId: string }
}

export interface AttioClient {
  settings: AttioSettings
  parent(kind: 'objects' | 'lists', ref: string): Promise<AttioParent>
  collection(request: CollectionRequest): AsyncGenerator<Page<AttioEntity, number>>
}

interface SendInit {
  method?: 'GET' | 'POST'
  query?: Record<string, string | number>
  body?: Record<string, unknown>
}

type Send = (path: string, init?: SendInit) => Promise<unknown>

const attributeValues = z.record(z.string(), z.array(z.unknown()))

export function createAttioClient(context: SourceContext, config: AttioReaderConfig): AttioClient {
  const { apiToken, ...settings } = attioReaderConfigSchema.parse(config)
  const send: Send = async (path, init = {}) => {
    const url = new URL(`https://api.attio.com/v2${path}`)
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, String(value))
    const response = await context.fetch(url, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'error',
    }).catch(explainAccessError)
    return response.json()
  }
  return {
    settings,
    parent: (kind, ref) => resolveParent(send, kind, ref),
    collection: (request) => readCollection(context, send, request),
  }
}

export function entityId(entity: AttioEntity, field: string): string {
  const value = entity.id[field]
  if (!value) throw new Error(`Attio entity is missing id.${field}.`)
  return value
}

async function resolveParent(send: Send, kind: 'objects' | 'lists', ref: string): Promise<AttioParent> {
  const idField = kind === 'objects' ? 'object_id' : 'list_id'
  const path = `/${kind}/${encodeURIComponent(ref)}`
  const schema = z.looseObject({ data: z.looseObject({ id: idSchema(['workspace_id', idField]), api_slug: z.string().min(1) }) })
  const { data } = schema.parse(await send(path))
  const parent = { workspaceId: entityId(data, 'workspace_id'), id: entityId(data, idField), slug: data.api_slug }
  if (ref !== parent.id && ref !== parent.slug) throw new Error(`Attio ${path} returned a different configured parent.`)
  return parent
}

function readCollection(context: SourceContext, send: Send, request: CollectionRequest) {
  const entities = z.array(entitySchema(request))
  const schema = z.looseObject({ data: request.pageSize === undefined ? entities : entities.max(request.pageSize) })
  const method = request.method ?? 'GET'
  return paginate<AttioEntity, number>({
    context, initial: 0, label: `${method} /v2${request.path}`,
    fetchPage: async (offset = 0) => {
      const pagination: Record<string, number> = request.pageSize === undefined ? {} : { limit: request.pageSize, offset }
      const payload = await send(request.path, method === 'GET'
        ? { query: { ...request.query, ...pagination } }
        : { method, query: request.query, body: { ...request.body, ...pagination } })
      const { data: items } = schema.parse(payload)
      for (const item of items) assertParent(item, request)
      const next = request.pageSize !== undefined && items.length === request.pageSize ? offset + items.length : undefined
      if (next !== undefined && !Number.isSafeInteger(next)) {
        throw new Error('Attio pagination offset exceeded the safe integer range.')
      }
      return { items, next }
    },
  })
}

function explainAccessError(error: unknown): never {
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    error.message += ' Check apiToken (ATTIO_API_TOKEN) and the resource scopes in the Attio README, or disable this stream.'
  }
  throw error
}

function entitySchema(request: CollectionRequest) {
  const values: Record<string, typeof attributeValues> = request.valuesField === undefined ? {} : { [request.valuesField]: attributeValues }
  return z.looseObject({ ...values, id: idSchema(request.idFields) })
}

function idSchema(fields: readonly string[]) {
  return z.object(Object.fromEntries(fields.map((field) => [field, z.string().min(1)]))).catchall(z.string())
}

function assertParent(entity: AttioEntity, request: CollectionRequest): void {
  if (request.parent && (entityId(entity, 'workspace_id') !== request.parent.workspaceId
    || entityId(entity, request.parent.field) !== request.parent.id)) {
    throw new Error(`Attio ${request.path} returned an entity from a different workspace or parent than the resolved collection.`)
  }
}
