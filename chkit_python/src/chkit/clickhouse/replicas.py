"""Read every replica of a multi-replica target.

Port of ``packages/clickhouse/src/replicas.ts`` (#265). On a target whose
requests a load balancer spreads over several replicas (a multi-replica
ObsessionDB service), a read answers from whichever replica it lands on, which
may not have applied the latest DDL or journal write yet. chkit reads every
replica through ``clusterAllReplicas`` instead.
"""

from __future__ import annotations

import re
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
    the user cannot query it, so callers keep their single-replica path. Any
    other failure also returns None, but is not cached: the next call probes
    again.
    """
    try:
        return resolve_replica_fanout_or_raise(client, cluster)
    except Exception:
        return None


def resolve_replica_fanout_or_raise(
    client: Any, cluster: str | None = None
) -> ReplicaFanout | None:
    """``resolve_replica_fanout`` for a caller that must not take a failed probe
    for a single replica (#700): a failure other than a missing cluster or a
    user that cannot query it raises, and is not cached."""
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
    except Exception as error:
        if _has_no_fanout(error):
            return None
        raise
    replicas = int(rows[0].get("replicas", 0)) if rows else 0
    return ReplicaFanout(cluster=cluster, replicas=replicas) if replicas > 1 else None


_NO_FANOUT_CODES = frozenset({"701", "170", "497"})
_NO_FANOUT_MESSAGE = re.compile(
    r"CLUSTER_DOESNT_EXIST|Requested cluster '.*' not found|ACCESS_DENIED|Not enough privileges"
)
_CODE = re.compile(r"\bcode: (\d+)", re.IGNORECASE)


def _has_no_fanout(error: BaseException) -> bool:
    """Whether ``error`` says the target has no fan-out chkit can use.

    The cluster does not exist (CLUSTER_DOESNT_EXIST, or BAD_GET on older
    servers) or the user may not query it (ACCESS_DENIED). The ObsessionDB
    console API sends only the message.
    """
    text = str(error)
    code = _CODE.search(text)
    if code is not None and code.group(1) in _NO_FANOUT_CODES:
        return True
    return _NO_FANOUT_MESSAGE.search(text) is not None


def string_literal(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"
