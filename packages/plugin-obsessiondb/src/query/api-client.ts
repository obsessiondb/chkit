import type { Credentials } from '../auth/index.js'
import { apiRequest } from '../api-request.js'

function queryPath(serviceId: string, action: string): string {
  return `/api/v1/services/${serviceId}/query/${action}`
}

export async function remoteCommand(
  serviceId: string,
  sql: string,
  creds: Credentials
): Promise<void> {
  await apiRequest<{ ok: boolean }>(queryPath(serviceId, 'command'), creds, { sql })
}

export async function remoteQuery<T>(
  serviceId: string,
  sql: string,
  creds: Credentials
): Promise<T[]> {
  const res = await apiRequest<{ rows: T[] }>(queryPath(serviceId, 'query'), creds, { sql })
  return res.rows
}

export async function remoteInsert<T extends Record<string, unknown>>(
  serviceId: string,
  params: { table: string; values: T[] },
  creds: Credentials
): Promise<void> {
  await apiRequest<{ ok: boolean }>(queryPath(serviceId, 'insert'), creds, params)
}

export async function remoteSubmit(
  serviceId: string,
  sql: string,
  creds: Credentials,
  queryId?: string
): Promise<string> {
  const res = await apiRequest<{ query_id: string }>(queryPath(serviceId, 'submit'), creds, {
    sql,
    query_id: queryId,
  })
  return res.query_id
}

export async function remoteQueryStatus(
  serviceId: string,
  queryId: string,
  creds: Credentials,
  options?: { afterTime?: string }
): Promise<{
  status: 'running' | 'finished' | 'failed' | 'unknown'
  readRows?: number
  readBytes?: number
  writtenRows?: number
  writtenBytes?: number
  elapsedMs?: number
  durationMs?: number
  error?: string
}> {
  return apiRequest(queryPath(serviceId, 'status'), creds, {
    query_id: queryId,
    ...options,
  })
}

export async function remoteListSchemaObjects(
  serviceId: string,
  creds: Credentials
): Promise<Array<{ kind: 'table' | 'view' | 'materialized_view'; database: string; name: string }>> {
  const res = await apiRequest<{
    objects: Array<{ kind: 'table' | 'view' | 'materialized_view'; database: string; name: string }>
  }>(queryPath(serviceId, 'schema-objects'), creds)
  return res.objects
}

export async function remoteListTableDetails(
  serviceId: string,
  databases: string[],
  creds: Credentials
): Promise<unknown[]> {
  const res = await apiRequest<{ tables: unknown[] }>(
    queryPath(serviceId, 'table-details'),
    creds,
    { databases }
  )
  return res.tables
}
