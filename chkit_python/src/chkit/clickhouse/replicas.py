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


#: The SETTINGS of a read that proves what ran (#765): no replica left out,
#: and the strict control settings, so an inherited cache or overflow mode
#: (``read_overflow_mode = 'break'``) never returns a partial result as a
#: whole one. A user who may not change them gets an error: the read fails
#: closed. TS ``STRICT_READ_SETTINGS``.
STRICT_READ_SETTINGS = ", ".join(
    (
        "skip_unavailable_shards = 0",
        "use_query_cache = 0",
        "enable_reads_from_query_cache = 0",
        "enable_writes_to_query_cache = 0",
        "read_overflow_mode = 'throw'",
        "read_overflow_mode_leaf = 'throw'",
        "group_by_overflow_mode = 'throw'",
        "sort_overflow_mode = 'throw'",
        "result_overflow_mode = 'throw'",
        "timeout_overflow_mode = 'throw'",
        "timeout_overflow_mode_leaf = 'throw'",
        "set_overflow_mode = 'throw'",
        "transfer_overflow_mode = 'throw'",
        "distinct_overflow_mode = 'throw'",
    )
)


def all_replicas(fanout: ReplicaFanout, source: str) -> str:
    """``source`` read on every replica, e.g. ``all_replicas(fanout, "system.tables")``."""
    return f"clusterAllReplicas({string_literal(fanout.cluster)}, {source})"


def _probe_replicas(client: Any, cluster: str) -> ReplicaFanout | None:
    try:
        rows = client.query(
            "SELECT count(DISTINCT hostName()) AS replicas "
            f"FROM clusterAllReplicas({string_literal(cluster)}, system.one)",
            settings={"default_format": "JSONStrings"},
        ).rows
    except Exception as error:
        if _is_missing_cluster(error) or _is_access_denied(error):
            return None
        raise
    replicas = int(rows[0].get("replicas", 0)) if rows else 0
    return ReplicaFanout(cluster=cluster, replicas=replicas) if replicas > 1 else None


@dataclass(frozen=True)
class ReplicaAccess:
    """Whether every replica of a cluster can be read (TS ``ReplicaAccess``).

    The probe reads every replica with ``skip_unavailable_shards = 0``, so a
    replica that does not answer fails it instead of being left out:

    - ``fanout``: every replica answered; read them through
      ``clusterAllReplicas``. One host is never taken for a single-node
      target: the fan-out reads it.
    - ``partial``: the cluster does not exist, the user may not query it, or
      the probe returned no replica count. A local read sees one replica of an
      unknown number, and a row it does not find may be on another.
    """

    kind: str  # fanout | partial
    fanout: ReplicaFanout | None = None
    reason: str | None = None


def probe_replica_access(client: Any, cluster: str | None = None) -> ReplicaAccess:
    """Probe ``cluster`` (default ``default``) for a caller that must prove a
    query runs, or ran, on no replica (#765). Any other failure, an
    unavailable replica included, raises. Not cached."""
    name = cluster or DEFAULT_CLUSTER
    try:
        rows = client.query(
            "SELECT count(DISTINCT hostName()) AS replicas "
            f"FROM clusterAllReplicas({string_literal(name)}, system.one) "
            f"SETTINGS {STRICT_READ_SETTINGS}"
        ).rows
    except Exception as error:
        if _is_missing_cluster(error):
            return ReplicaAccess(
                kind="partial",
                reason=f"the cluster {name} does not exist, so not every replica can be read",
            )
        if _is_access_denied(error):
            return ReplicaAccess(
                kind="partial", reason=f"the user may not read every replica ({error})"
            )
        raise
    replicas = _replica_count(rows)
    if replicas is None:
        return ReplicaAccess(
            kind="partial",
            reason=f"the replica probe of cluster {name} returned no replica count",
        )
    return ReplicaAccess(kind="fanout", fanout=ReplicaFanout(cluster=name, replicas=replicas))


def _replica_count(rows: Any) -> int | None:
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        return None
    value = rows[0].get("replicas")
    try:
        replicas = int(str(value))
    except ValueError:
        return None
    return replicas if replicas >= 1 else None


_MISSING_CLUSTER_CODES = frozenset({"701", "170"})
_MISSING_CLUSTER_MESSAGE = re.compile(
    r"CLUSTER_DOESNT_EXIST|Requested cluster '.*' not found"
)
_ACCESS_DENIED_MESSAGE = re.compile(r"ACCESS_DENIED|Not enough privileges")
_CODE = re.compile(r"\bcode: (\d+)", re.IGNORECASE)


def _error_code(error: BaseException) -> str | None:
    code = _CODE.search(str(error))
    return code.group(1) if code is not None else None


def _is_missing_cluster(error: BaseException) -> bool:
    """The cluster does not exist (CLUSTER_DOESNT_EXIST, or BAD_GET on older
    servers). The ObsessionDB console API sends only the message."""
    if _error_code(error) in _MISSING_CLUSTER_CODES:
        return True
    return _MISSING_CLUSTER_MESSAGE.search(str(error)) is not None


def _is_access_denied(error: BaseException) -> bool:
    """The user may not query the cluster (ACCESS_DENIED)."""
    if _error_code(error) == "497":
        return True
    return _ACCESS_DENIED_MESSAGE.search(str(error)) is not None


def string_literal(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"
