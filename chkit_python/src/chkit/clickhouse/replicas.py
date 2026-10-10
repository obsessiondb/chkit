"""Read every replica of a multi-replica target.

Port of ``packages/clickhouse/src/replicas.ts`` (#265). On a target whose
requests a load balancer spreads over several replicas (a multi-replica
ObsessionDB service), a read answers from whichever replica it lands on, which
may not have applied the latest DDL or journal write yet. chkit reads every
replica through ``clusterAllReplicas`` instead.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# ObsessionDB services expose their replicas as the cluster named ``default``.
DEFAULT_CLUSTER = "default"


@dataclass(frozen=True)
class ReplicaFanout:
    cluster: str
    replicas: int


# Keyed by ``id(client)``; the client is kept in the value so the id stays valid.
_probes: dict[tuple[int, str], tuple[Any, ReplicaFanout | None]] = {}


def resolve_replica_fanout(client: Any, cluster: str | None = None) -> ReplicaFanout | None:
    """Count the replicas of ``cluster`` (default ``default``) once per client.

    Returns None for a single replica, or when the cluster does not exist or
    the user cannot query it, so callers keep their single-replica path.
    """
    name = cluster or DEFAULT_CLUSTER
    key = (id(client), name)
    cached = _probes.get(key)
    if cached is not None and cached[0] is client:
        return cached[1]
    fanout = _probe_replicas(client, name)
    _probes[key] = (client, fanout)
    return fanout


def all_replicas(fanout: ReplicaFanout, source: str) -> str:
    """``source`` read on every replica, e.g. ``all_replicas(fanout, "system.tables")``."""
    return f"clusterAllReplicas({string_literal(fanout.cluster)}, {source})"


def _probe_replicas(client: Any, cluster: str) -> ReplicaFanout | None:
    try:
        rows = client.query(
            "SELECT count(DISTINCT hostName()) AS replicas "
            f"FROM clusterAllReplicas({string_literal(cluster)}, system.one)"
        ).rows
    except Exception:
        return None
    replicas = int(rows[0].get("replicas", 0)) if rows else 0
    return ReplicaFanout(cluster=cluster, replicas=replicas) if replicas > 1 else None


def string_literal(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"
