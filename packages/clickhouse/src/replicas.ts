import type { ClickHouseExecutor } from './index.js'

/**
 * A target whose requests a load balancer spreads over several replicas, such
 * as a multi-replica ObsessionDB service. A read there answers from whichever
 * replica it lands on, which may not have applied the latest DDL or journal
 * write yet, so chkit reads every replica through `clusterAllReplicas` instead.
 */
export interface ReplicaFanout {
  cluster: string
  replicas: number
}

/** ObsessionDB services expose their replicas as the cluster named `default`. */
const DEFAULT_CLUSTER = 'default'

const probes = new WeakMap<ClickHouseExecutor, Map<string, Promise<ReplicaFanout | undefined>>>()

/**
 * Counts the replicas of `cluster` (default `default`) once per executor.
 * Returns undefined for a single replica, or when the cluster does not exist
 * or the user cannot query it, so callers keep their single-replica path. Any
 * other failure also returns undefined, but is not cached: the next call
 * probes again.
 */
export function resolveReplicaFanout(
  executor: ClickHouseExecutor,
  cluster: string = DEFAULT_CLUSTER,
): Promise<ReplicaFanout | undefined> {
  return resolveReplicaFanoutOrThrow(executor, cluster).catch(() => undefined)
}

/**
 * resolveReplicaFanout for a caller that must not take a failed probe for a
 * single replica (#700): a failure other than a missing cluster or a user
 * that cannot query it rejects, and is not cached.
 */
export function resolveReplicaFanoutOrThrow(
  executor: ClickHouseExecutor,
  cluster: string = DEFAULT_CLUSTER,
): Promise<ReplicaFanout | undefined> {
  let byCluster = probes.get(executor)
  if (!byCluster) {
    byCluster = new Map()
    probes.set(executor, byCluster)
  }
  const cached = byCluster.get(cluster)
  if (cached) return cached
  const probe = probeReplicas(executor, cluster)
  byCluster.set(cluster, probe)
  probe.catch(() => {
    if (byCluster.get(cluster) === probe) byCluster.delete(cluster)
  })
  return probe
}

/** `source` read on every replica, e.g. `allReplicas(fanout, 'system.tables')`. */
export function allReplicas(fanout: ReplicaFanout, source: string): string {
  return `clusterAllReplicas(${stringLiteral(fanout.cluster)}, ${source})`
}

async function probeReplicas(
  executor: ClickHouseExecutor,
  cluster: string,
): Promise<ReplicaFanout | undefined> {
  const access = await probeReplicaAccess(executor, cluster)
  return access.kind === 'fanout' ? access.fanout : undefined
}

/**
 * What a read of every replica of `cluster` (default `default`) can see, for a
 * caller that must prove a query runs, or ran, on no replica (#765):
 * - `fanout`: several replicas, read through `clusterAllReplicas`;
 * - `single`: one replica, or no such cluster, so local reads see everything;
 * - `denied`: the user may not query the cluster, so a local read sees one
 *   replica of an unknown number, and a row it does not find may be on another.
 * Any other failure rejects. Not cached.
 */
export type ReplicaAccess =
  | { kind: 'fanout'; fanout: ReplicaFanout }
  | { kind: 'single' }
  | { kind: 'denied'; error: string }

export async function probeReplicaAccess(
  executor: ClickHouseExecutor,
  cluster: string = DEFAULT_CLUSTER,
): Promise<ReplicaAccess> {
  try {
    const rows = await executor.query<{ replicas: number | string }>(
      `SELECT count(DISTINCT hostName()) AS replicas FROM clusterAllReplicas(${stringLiteral(cluster)}, system.one)`,
    )
    const replicas = Number(rows[0]?.replicas ?? 0)
    return replicas > 1 ? { kind: 'fanout', fanout: { cluster, replicas } } : { kind: 'single' }
  } catch (error) {
    if (isMissingCluster(error)) return { kind: 'single' }
    if (isAccessDenied(error)) return { kind: 'denied', error: error instanceof Error ? error.message : String(error) }
    throw error
  }
}

/**
 * Whether `error` says the cluster does not exist (CLUSTER_DOESNT_EXIST, or
 * BAD_GET on older servers). The ObsessionDB console API sends only the message.
 */
function isMissingCluster(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = 'code' in error ? String(error.code) : ''
  if (code === '701' || code === '170') return true
  return /CLUSTER_DOESNT_EXIST|Requested cluster '.*' not found/.test(error.message)
}

/** Whether `error` says the user may not query the cluster (ACCESS_DENIED). */
function isAccessDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = 'code' in error ? String(error.code) : ''
  if (code === '497') return true
  return /ACCESS_DENIED|Not enough privileges/.test(error.message)
}

export function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
