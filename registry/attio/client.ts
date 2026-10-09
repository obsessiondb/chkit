import { setTimeout as sleep } from 'node:timers/promises'

import { HttpError, IngestConfigError, paginate, rawRows, type ErrorClassifier, type FetchContext } from '@chkit/plugin-ingest'

import { attioConfig, type AttioReaderConfig } from './config.js'

export type AttioEntity = Record<string, unknown> & { id: Record<string, string> }

export interface AttioClientDeps {
  config: AttioReaderConfig
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string | undefined
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

interface CollectionRequest {
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

export const defaultAttioClientDeps: AttioClientDeps = {
  config: attioConfig,
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.ATTIO_API_TOKEN,
  wait: async (milliseconds, signal) => { await sleep(milliseconds, undefined, { signal }) },
}

/** Resolve one configured object/list; each stream owns one collection. */
export async function* readParentCollection(
  context: FetchContext,
  input: {
    resource: string
    parent: { kind: 'objects' | 'lists'; ref: string }
    request: (parent: AttioEntity) => CollectionRequest
  },
  deps: AttioClientDeps = defaultAttioClientDeps,
) {
  const idField = input.parent.kind === 'objects' ? 'object_id' : 'list_id'
  const path = `/${input.parent.kind}/${encodeURIComponent(input.parent.ref)}`
  const parent = await context.attempt(async (signal) => {
    const entity = parseEntity(await requestData({ path, idFields: ['workspace_id', idField] }, 0, signal, deps), {
      path, idFields: ['workspace_id', idField],
    })
    entitySlug(entity)
    if (input.parent.ref !== entityId(entity, idField) && input.parent.ref !== entitySlug(entity)) {
      throw new IngestConfigError(`Attio ${path} returned a different configured parent.`)
    }
    return entity
  }, { label: `GET /v2${path}` })
  const request = { ...input.request(parent), parent: {
    field: input.parent.kind === 'objects' || input.resource === 'list_attributes' ? 'object_id' as const : 'list_id' as const,
    id: entityId(parent, idField), workspaceId: entityId(parent, 'workspace_id'),
  } }
  yield* readRows(context, {
    resource: input.resource, request,
    metadata: input.parent.kind === 'objects' ? { object_slug: entitySlug(parent) } : { list_slug: entitySlug(parent) },
  }, deps)
}

export async function* readRows(
  context: FetchContext,
  input: { resource: string; request: CollectionRequest; metadata?: { object_slug?: string; list_slug?: string } },
  deps: AttioClientDeps = defaultAttioClientDeps,
) {
  for await (const page of readCollection(context, input.request, deps)) {
    yield { rows: toAttioRows(page.items, input.resource, input.request.idFields, input.metadata, deps.config.sourceId) }
  }
}

/** Each page is validated inside attempt, so executor retry/cancellation owns every request. */
export function readCollection(
  context: FetchContext,
  request: CollectionRequest,
  deps: AttioClientDeps = defaultAttioClientDeps,
) {
  if (request.pageSize !== undefined && (!Number.isSafeInteger(request.pageSize) || request.pageSize <= 0)) {
    throw new IngestConfigError('Attio pageSize must be a positive safe integer.')
  }
  return paginate({
    context, initial: 0, label: `${request.method ?? 'GET'} /v2${request.path}`,
    fetchPage: async (offset = 0, signal) => {
      const data = await requestData(request, offset, signal, deps)
      if (!Array.isArray(data)) throw new IngestConfigError(`Attio ${request.path} returned no data array.`)
      const items = data.map((value: unknown) => parseEntity(value, request))
      if (request.pageSize !== undefined && items.length > request.pageSize) {
        throw new IngestConfigError(`Attio ${request.path} returned more rows than the requested page size.`)
      }
      const next = request.pageSize !== undefined && items.length === request.pageSize ? offset + items.length : undefined
      if (next !== undefined && !Number.isSafeInteger(next)) {
        throw new IngestConfigError('Attio pagination offset exceeded the safe integer range.')
      }
      return { items, next }
    },
  })
}

/** Original provider fields stay under data; metadata does not overwrite custom attributes. */
function toAttioRows(
  items: readonly AttioEntity[],
  resource: string,
  idFields: readonly string[],
  metadata: { object_slug?: string; list_slug?: string } = {},
  sourceId = attioConfig.sourceId,
) {
  return rawRows(
    items.map((data) => ({ source_id: sourceId, ...metadata, data })),
    ({ data }) => JSON.stringify([sourceId, resource, ...idFields.map((field) => entityId(data, field))]),
  )
}

export function entityId(entity: AttioEntity, field: string): string {
  const value = entity.id[field]
  if (!value) throw new IngestConfigError(`Attio entity is missing id.${field}.`)
  return value
}

function entitySlug(entity: AttioEntity): string {
  if (typeof entity.api_slug !== 'string' || entity.api_slug.length === 0) {
    throw new IngestConfigError('Attio object/list is missing api_slug.')
  }
  return entity.api_slug
}

/** Invalid successful responses/configurations cannot be fixed by retrying. */
export const classifyAttioError: ErrorClassifier = (cause) => {
  if (cause instanceof IngestConfigError || cause instanceof SyntaxError) return { kind: 'permanent' }
  // HttpError preserves 429 Retry-After dates, 5xx retries, and permanent 4xx semantics.
  return undefined
}

async function requestData(
  request: CollectionRequest,
  offset: number,
  signal: AbortSignal,
  deps: AttioClientDeps,
): Promise<unknown> {
  const token = deps.token()?.trim()
  if (!token) throw new IngestConfigError('Set ATTIO_API_TOKEN before running Attio ingestion. Schema imports do not need credentials.')
  const url = new URL(`https://api.attio.com/v2${request.path}`)
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value)
  const method = request.method ?? 'GET'
  const pagination = request.pageSize === undefined ? {} : { limit: request.pageSize, offset }
  if (method === 'GET') {
    for (const [key, value] of Object.entries(pagination)) url.searchParams.set(key, String(value))
  }
  // The default pipeline runs one request at a time: <=40 reads/s and <=8 notes/s.
  // Attio may lower limits and applies query-complexity limits; 429s still use executor backoff.
  await deps.wait(request.path === '/notes' ? 125 : 25, signal)
  signal.throwIfAborted()
  const response = await deps.fetch(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({ ...request.body, ...pagination }) } : {}),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: 'error',
  })
  if (!response.ok) {
    const error = await HttpError.fromResponse(response)
    if (response.status === 401 || response.status === 403) {
      error.message += ' Check ATTIO_API_TOKEN and the resource scopes in the Attio README, or disable this stream.'
    }
    throw error
  }
  const payload: unknown = await response.json()
  if (!isObject(payload) || !('data' in payload)) {
    throw new IngestConfigError(`Attio ${request.path} returned no data field.`)
  }
  return payload.data
}

function parseEntity(value: unknown, request: CollectionRequest): AttioEntity {
  if (!isEntity(value)) throw new IngestConfigError(`Attio ${request.path} returned an entity without a valid id object.`)
  for (const field of request.idFields) entityId(value, field)
  if (request.parent && (entityId(value, 'workspace_id') !== request.parent.workspaceId
    || entityId(value, request.parent.field) !== request.parent.id)) {
    throw new IngestConfigError(`Attio ${request.path} returned an entity from a different workspace or parent than the resolved collection.`)
  }
  if (request.valuesField !== undefined) {
    const values = value[request.valuesField]
    if (!isObject(values) || !Object.values(values).every(Array.isArray)) {
      throw new IngestConfigError(`Attio ${request.path} returned invalid ${request.valuesField}; expected arrays of attribute values.`)
    }
  }
  return value
}

function isEntity(value: unknown): value is AttioEntity {
  return isObject(value) && isObject(value.id) && Object.values(value.id).every((part) => typeof part === 'string')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
