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

/**
 * The SETTINGS of a read that proves what ran (#765): no replica left out
 * (`skip_unavailable_shards = 0`), and `STRICT_CONTROL_SETTINGS`, so an
 * inherited cache or overflow mode (`read_overflow_mode = 'break'`) never
 * returns a partial result as a whole one. A user who may not change them
 * gets an error: the read fails closed.
 */
export const STRICT_READ_SETTINGS = "skip_unavailable_shards = 0, use_query_cache = 0, enable_reads_from_query_cache = 0, enable_writes_to_query_cache = 0, read_overflow_mode = 'throw', read_overflow_mode_leaf = 'throw', group_by_overflow_mode = 'throw', sort_overflow_mode = 'throw', result_overflow_mode = 'throw', timeout_overflow_mode = 'throw', timeout_overflow_mode_leaf = 'throw', set_overflow_mode = 'throw', transfer_overflow_mode = 'throw', distinct_overflow_mode = 'throw'"

/** `source` read on every replica, e.g. `allReplicas(fanout, 'system.tables')`. */
export function allReplicas(fanout: ReplicaFanout, source: string): string {
  return `clusterAllReplicas(${stringLiteral(fanout.cluster)}, ${source})`
}

async function probeReplicas(
  executor: ClickHouseExecutor,
  cluster: string,
): Promise<ReplicaFanout | undefined> {
  try {
    const rows = await executor.query<{ replicas: number | string }>(
      `SELECT count(DISTINCT hostName()) AS replicas FROM clusterAllReplicas(${stringLiteral(cluster)}, system.one)`,
    )
    const replicas = Number(rows[0]?.replicas ?? 0)
    return replicas > 1 ? { cluster, replicas } : undefined
  } catch (error) {
    if (isMissingCluster(error) || isAccessDenied(error)) return undefined
    throw error
  }
}

/**
 * Whether every replica of `cluster` (default `default`) can be read, for a
 * caller that must prove a query runs, or ran, on no replica (#765). The
 * probe reads every replica with `skip_unavailable_shards = 0`, so a replica
 * that does not answer fails it instead of being left out:
 * - `fanout`: every replica answered; read them through `clusterAllReplicas`.
 *   One host is never taken for a single-node target: the fan-out reads it.
 * - `partial`: the cluster does not exist, the user may not query it, or the
 *   probe returned no replica count. A local read sees one replica of an
 *   unknown number, and a row it does not find may be on another.
 * Any other failure, an unavailable replica included, rejects. Not cached.
 */
export type ReplicaAccess =
  | { kind: 'fanout'; fanout: ReplicaFanout }
  | { kind: 'partial'; reason: string }

export async function probeReplicaAccess(
  executor: ClickHouseExecutor,
  cluster: string = DEFAULT_CLUSTER,
): Promise<ReplicaAccess> {
  let rows: Array<{ replicas?: number | string }>
  try {
    rows = await executor.query<{ replicas?: number | string }>(
      `SELECT count(DISTINCT hostName()) AS replicas FROM clusterAllReplicas(${stringLiteral(cluster)}, system.one) SETTINGS ${STRICT_READ_SETTINGS}`,
    )
  } catch (error) {
    if (isMissingCluster(error)) {
      return { kind: 'partial', reason: `the cluster ${cluster} does not exist, so not every replica can be read` }
    }
    if (isAccessDenied(error)) {
      return { kind: 'partial', reason: `the user may not read every replica (${error instanceof Error ? error.message : String(error)})` }
    }
    throw error
  }
  const replicas = rows.length === 1 ? Number(rows[0]?.replicas) : Number.NaN
  if (!Number.isInteger(replicas) || replicas < 1) {
    return { kind: 'partial', reason: `the replica probe of cluster ${cluster} returned no replica count` }
  }
  return { kind: 'fanout', fanout: { cluster, replicas } }
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
