import type { Credentials } from '../auth/index.js'

export interface RemotePlanResponse {
  ok: boolean
  plan_id?: string
  error?: string
  [key: string]: unknown
}

export interface RemoteRunResponse {
  ok: boolean
  run_id?: string
  error?: string
  [key: string]: unknown
}

export interface RemoteStatusResponse {
  ok: boolean
  status?: string
  error?: string
  [key: string]: unknown
}

export interface RemoteCancelResponse {
  ok: boolean
  error?: string
  [key: string]: unknown
}

export interface RemoteDoctorResponse {
  ok: boolean
  error?: string
  [key: string]: unknown
}

class SessionExpiredError extends Error {
  constructor() {
    super('Session expired. Run `chkit obsessiondb login` to re-authenticate.')
  }
}

async function apiRequest<T>(
  path: string,
  creds: Credentials,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${creds.base_url}${path}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'chkit-cli',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  if (res.status === 401) {
    throw new SessionExpiredError()
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Remote backfill API error: ${res.status} ${text}`)
  }

  return (await res.json()) as T
}

export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof SessionExpiredError
}

export async function submitBackfillPlan(
  input: Record<string, unknown>,
  creds: Credentials
): Promise<RemotePlanResponse> {
  return apiRequest('/api/v1/backfill/plan', creds, input)
}

export async function runRemoteBackfill(
  input: Record<string, unknown>,
  creds: Credentials
): Promise<RemoteRunResponse> {
  return apiRequest('/api/v1/backfill/run', creds, input)
}

export async function resumeRemoteBackfill(
  input: Record<string, unknown>,
  creds: Credentials
): Promise<RemoteRunResponse> {
  return apiRequest('/api/v1/backfill/resume', creds, input)
}

export async function getRemoteBackfillStatus(
  input: Record<string, unknown>,
  creds: Credentials
): Promise<RemoteStatusResponse> {
  return apiRequest('/api/v1/backfill/status', creds, input)
}

export async function cancelRemoteBackfill(
  input: Record<string, unknown>,
  creds: Credentials
): Promise<RemoteCancelResponse> {
  return apiRequest('/api/v1/backfill/cancel', creds, input)
}

export async function getRemoteBackfillDoctor(
  input: Record<string, unknown>,
  creds: Credentials
): Promise<RemoteDoctorResponse> {
  return apiRequest('/api/v1/backfill/doctor', creds, input)
}
