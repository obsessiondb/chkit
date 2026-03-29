import type { Credentials } from '../auth/index.js'
import { apiRequest, isSessionExpiredError } from '../api-request.js'

export { isSessionExpiredError }

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
