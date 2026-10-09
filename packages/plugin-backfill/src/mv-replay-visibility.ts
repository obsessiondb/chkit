// Visibility policy for live backfill e2e tests (mv_replay and executeBackfill).
// Production backfill does not read system.replicas; this module stays out of
// the package build.

const ACCESS_DENIED_CODE = '497'

export type ReplicaVisibility =
  | { kind: 'single-node'; samples: 1 }
  | { kind: 'counted'; activeReplicas: number; samples: number }
  | { kind: 'grant-denied'; samples: 1 }

export type ReplicaSync = 'synced' | 'denied'

// Shared and Replicated engines keep a copy of each part per replica. Plain
// MergeTree (the single-node verify service) does not.
export function engineNeedsReplicaSync(engine: string | undefined): boolean {
  return /Shared|Replicated/.test(engine ?? '')
}

// `readActiveReplicas` runs only for replicated/shared engines. A missing
// SELECT grant on system.replicas (ObsessionDB's managed role) is not fatal:
// one ready sample is enough to start, and empty-chunk replay covers a
// replica that sample did not visit.
export async function resolveReplicaVisibility(
  engine: string | undefined,
  readActiveReplicas: () => Promise<number>,
): Promise<ReplicaVisibility> {
  if (!engineNeedsReplicaSync(engine)) return { kind: 'single-node', samples: 1 }
  try {
    const activeReplicas = await readActiveReplicas()
    return {
      kind: 'counted',
      activeReplicas,
      samples: samplesForActiveReplicas(activeReplicas),
    }
  } catch (error) {
    if (!isAccessDenied(error)) throw error
    return { kind: 'grant-denied', samples: 1 }
  }
}

// SYSTEM SYNC REPLICA is a different privilege from SELECT on system.replicas.
// When the managed role has it, sync the session we landed on. When it does
// not, keep going — the chunk settings and the empty-chunk replay do not
// need this command.
export async function syncReplicaUnlessDenied(sync: () => Promise<void>): Promise<ReplicaSync> {
  try {
    await sync()
    return 'synced'
  } catch (error) {
    if (!isAccessDenied(error)) throw error
    return 'denied'
  }
}

function samplesForActiveReplicas(activeReplicas: number): number {
  if (!Number.isFinite(activeReplicas)) return 1
  return Math.max(1, Math.floor(activeReplicas))
}

export function isAccessDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as { code?: unknown; type?: unknown; message?: unknown }
  if (String(record.code ?? '') === ACCESS_DENIED_CODE) return true
  if (String(record.type ?? '') === 'ACCESS_DENIED') return true
  return typeof record.message === 'string' && /not enough privileges/i.test(record.message)
}
