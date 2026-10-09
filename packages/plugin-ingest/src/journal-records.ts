import { createHash } from 'node:crypto'

import type { CommittedCheckpoint, JournalEvent } from './types.js'

// A type alias (not an interface) so it is assignable to the executor's Record-based insert values.
export type JournalRow = {
  target_id: string
  namespace_id: string
  event_seq: string
  event_id: string
  payload_hash: string
  event_at: string
  event_kind: string
  run_id: string
  work_id: string
  attempt_no: number
  batch_id: string
  expected_checkpoint_version: string
  checkpoint_version: string
  checkpoint_json: string
  work_state: string
  sink_evidence: string
  retry_at: string | null
  error_class: string
  detail_json: string
}

export function toJournalRow(event: JournalEvent, targetId: string, at: Date): JournalRow {
  const checkpointJson = event.checkpoint ? canonicalJson(event.checkpoint) : ''
  const detailJson = canonicalJson(event.detail)
  // Identity covers what makes the fact unique; the payload hash covers every
  // authoritative field a retry of that same fact must reproduce. Only the
  // physical append time (event_at) is excluded.
  const eventId = digest([targetId, event.namespaceId, event.runId, String(event.eventSeq), event.eventKind, event.workId, event.batchId, String(event.attemptNo)])
  const payload = digest([
    eventId,
    String(event.expectedCheckpointVersion),
    String(event.checkpointVersion),
    checkpointJson,
    event.workState,
    event.sinkEvidence,
    event.errorClass,
    event.runId,
    event.retryAt ? event.retryAt.toISOString() : '',
    detailJson,
  ])
  return {
    target_id: targetId,
    namespace_id: event.namespaceId,
    event_seq: String(event.eventSeq),
    event_id: eventId,
    payload_hash: BigInt(`0x${payload.slice(0, 16)}`).toString(),
    event_at: toClickHouseDateTime(at),
    event_kind: event.eventKind,
    run_id: event.runId,
    work_id: event.workId,
    attempt_no: event.attemptNo,
    batch_id: event.batchId,
    expected_checkpoint_version: String(event.expectedCheckpointVersion),
    checkpoint_version: String(event.checkpointVersion),
    checkpoint_json: checkpointJson,
    work_state: event.workState,
    sink_evidence: event.sinkEvidence,
    retry_at: event.retryAt ? toClickHouseDateTime(event.retryAt) : null,
    error_class: event.errorClass,
    detail_json: detailJson,
  }
}

/** Stable key order so equal values always serialize identically. */
export function canonicalJson(value: unknown): string {
  // JSON.stringify(undefined) is undefined, not a string.
  return JSON.stringify(sortKeys(value)) ?? 'null'
}

export function digest(parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(part.length))
    hash.update(':')
    hash.update(part)
  }
  return hash.digest('hex')
}

export function emptyCheckpoint(): CommittedCheckpoint {
  return { version: 0, envelope: undefined, checkpointId: '', successId: '', headSeq: 0, lastSuccessSeq: 0 }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)])
    )
  }
  return value
}

function toClickHouseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

