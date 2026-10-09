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
 * or the user cannot query it, so callers keep their single-replica path.
 */
export function resolveReplicaFanout(
  executor: ClickHouseExecutor,
  cluster: string = DEFAULT_CLUSTER,
): Promise<ReplicaFanout | undefined> {
  let byCluster = probes.get(executor)
  if (!byCluster) {
    byCluster = new Map()
    probes.set(executor, byCluster)
  }
  let probe = byCluster.get(cluster)
  if (!probe) {
    probe = probeReplicas(executor, cluster)
    byCluster.set(cluster, probe)
  }
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
  try {
    const rows = await executor.query<{ replicas: number | string }>(
      `SELECT count(DISTINCT hostName()) AS replicas FROM clusterAllReplicas(${stringLiteral(cluster)}, system.one)`,
    )
    const replicas = Number(rows[0]?.replicas ?? 0)
    return replicas > 1 ? { cluster, replicas } : undefined
  } catch {
    return undefined
  }
}

export function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
