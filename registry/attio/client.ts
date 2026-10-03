import { setTimeout as sleep } from 'node:timers/promises'

import { HttpError, IngestConfigError, rawRows, type ErrorClassifier, type FetchContext } from '@chkit/plugin-ingest'

import { attioConfig } from './config.js'

export type AttioEntity = Record<string, unknown> & { id: Record<string, string> }

export interface AttioClientDeps {
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
}

const defaultDeps: AttioClientDeps = {
  fetch: (url, init) => fetch(url, init),
  token: () => process.env.ATTIO_API_TOKEN,
  wait: async (milliseconds, signal) => { await sleep(milliseconds, undefined, { signal }) },
}

/** Each page is validated inside attempt, so executor retry/cancellation owns every request. */
export async function* readCollection(
  context: FetchContext,
  request: CollectionRequest,
  deps: AttioClientDeps = defaultDeps,
): AsyncGenerator<AttioEntity[]> {
  if (request.pageSize !== undefined && (!Number.isSafeInteger(request.pageSize) || request.pageSize <= 0)) {
    throw new IngestConfigError('Attio pageSize must be a positive safe integer.')
  }
  let offset = 0
  while (true) {
    context.signal.throwIfAborted()
    const currentOffset = offset
    const page = await context.attempt(
      (signal) => requestPage(request, currentOffset, signal, deps),
      { label: `${request.method ?? 'GET'} /v2${request.path}` },
    )
    if (page.length > 0) yield page
    if (request.pageSize === undefined || page.length < request.pageSize) return
    offset += page.length
    if (!Number.isSafeInteger(offset)) throw new IngestConfigError('Attio pagination offset exceeded the safe integer range.')
  }
}

export async function discoverObjects(context: FetchContext, deps?: AttioClientDeps): Promise<AttioEntity[]> {
  for await (const objects of readCollection(context, { path: '/objects', idFields: ['workspace_id', 'object_id'] }, deps)) {
    return selectEntities(objects, attioConfig.objects, 'object_id')
  }
  return selectEntities([], attioConfig.objects, 'object_id')
}

export async function discoverLists(context: FetchContext, deps?: AttioClientDeps): Promise<AttioEntity[]> {
  for await (const lists of readCollection(context, { path: '/lists', idFields: ['workspace_id', 'list_id'] }, deps)) {
    return selectEntities(lists, attioConfig.lists, 'list_id')
  }
  return selectEntities([], attioConfig.lists, 'list_id')
}

/** Original provider fields stay under data; metadata does not overwrite custom attributes. */
export function toAttioRows(
  items: readonly AttioEntity[],
  resource: string,
  idFields: readonly string[],
  metadata: { object_slug?: string; list_slug?: string } = {},
) {
  return rawRows(
    items.map((data) => ({ source_id: attioConfig.sourceId, ...metadata, data })),
    ({ data }) => JSON.stringify([attioConfig.sourceId, resource, ...idFields.map((field) => entityId(data, field))]),
  )
}

export function entityId(entity: AttioEntity, field: string): string {
  const value = entity.id[field]
  if (!value) throw new IngestConfigError(`Attio entity is missing id.${field}.`)
  return value
}

export function entitySlug(entity: AttioEntity): string {
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

async function requestPage(
  request: CollectionRequest,
  offset: number,
  signal: AbortSignal,
  deps: AttioClientDeps,
): Promise<AttioEntity[]> {
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
  if (!isObject(payload) || !Array.isArray(payload.data)) {
    throw new IngestConfigError(`Attio ${request.path} returned no data array.`)
  }
  return payload.data.map((value: unknown) => parseEntity(value, request))
}

function selectEntities(entities: AttioEntity[], selection: readonly string[] | undefined, idField: string): AttioEntity[] {
  // Validate slugs even when all resources are selected: records/views rely on this metadata.
  for (const entity of entities) entitySlug(entity)
  if (selection === undefined) return entities
  for (const wanted of selection) {
    if (!entities.some((entity) => entityId(entity, idField) === wanted || entitySlug(entity) === wanted)) {
      throw new IngestConfigError(`Configured Attio ${idField} or slug "${wanted}" was not found or is not accessible.`)
    }
  }
  return entities.filter((entity) => selection.includes(entityId(entity, idField)) || selection.includes(entitySlug(entity)))
}

function parseEntity(value: unknown, request: CollectionRequest): AttioEntity {
  if (!isEntity(value)) throw new IngestConfigError(`Attio ${request.path} returned an entity without a valid id object.`)
  for (const field of request.idFields) entityId(value, field)
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
