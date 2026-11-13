"""Verified cancellation of one stopped migrate holder's immutable query ids."""

from __future__ import annotations

import json
import math
import re
import time
from dataclasses import dataclass, replace
from typing import Any, Literal, Protocol

from chkit import __version__
from chkit.cli.commands.migrate_lock import (
    LOCK_ROW_PREFIX,
    LockTarget,
    claims_select_sql,
)
from chkit.cli.commands.migrate_query_intents import (
    QUERY_INTENT_PREFIX,
    QueryIdentity,
    cancellation_error,
    sql_string,
)
from chkit.clickhouse.replicas import ReplicaFanout
from chkit.core.identifier import quote_identifier

CANCELLATION_PREFIX = "__chkit_migrate_cancel__/"
_DEADLINE_MS = 30_000
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_FINGERPRINT = re.compile(r"^v1:[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class CancellationPlan:
    claim: str
    holder: str
    identity: QueryIdentity
    resume_pending: bool = False


@dataclass(frozen=True, slots=True)
class _Topology:
    identity: QueryIdentity
    hosts: list[str]


class _LockCheck(Protocol):
    def assert_held(self) -> None: ...


class _Control:
    def __init__(
        self,
        client: Any,
        lock: _LockCheck | None = None,
        *,
        fallback: bool = False,
    ) -> None:
        self._client = client
        self._lock = lock
        self._deadline = time.monotonic() + _DEADLINE_MS / 1000
        self._fallback = fallback
        if not fallback and (
            not callable(getattr(client, "query_control", None))
            or not callable(getattr(client, "execute_tracked", None))
        ):
            raise cancellation_error(
                "This executor cannot safely track and cancel physical queries."
            )

    def remaining(self) -> float:
        if self._lock is not None:
            self._lock.assert_held()
        remaining = (self._deadline - time.monotonic()) * 1000
        if remaining <= 0:
            raise cancellation_error("Cancellation deadline expired; replacement work is blocked.")
        return remaining

    def query(self, sql: str) -> list[dict[str, Any]]:
        if self._fallback:
            return list(self._client.query(sql).rows)
        rows = list(self._client.query_control(sql, self.remaining()).rows)
        self.remaining()
        return rows


def resolve_query_identity(client: Any, configured_cluster: str | None = None) -> QueryIdentity:
    cluster = configured_cluster or getattr(client, "query_control_cluster", None)
    if not isinstance(cluster, str) or not cluster:
        raise cancellation_error(
            "Cancellation requires a declared ClickHouse cluster "
            "(clickhouse.cluster or the console transport cluster)."
        )
    return _topology(_Control(client), cluster).identity


def prepare_cancellation(
    client: Any,
    target: LockTarget,
    identity: QueryIdentity,
    requested_claim: str,
) -> CancellationPlan:
    claim = requested_claim.removeprefix(LOCK_ROW_PREFIX)
    if not _UUID.fullmatch(claim):
        raise cancellation_error("Cancellation requires an exact recorded claim UUID.")
    if len(identity.server_uuids) != 1:
        raise cancellation_error(
            "Cancellation recovery currently requires one declared server; "
            "plain MergeTree compensation cannot cover independent replica tables."
        )
    conn = _Control(client)
    _assert_identity_topology(conn, identity)
    source_target = replace(
        target,
        fanout=ReplicaFanout(_require_cluster(identity), len(identity.server_uuids)),
    )
    rows = conn.query(claims_select_sql(source_target, f"{LOCK_ROW_PREFIX}{claim}"))
    predecessor = next((row for row in rows if row["name"] == f"{LOCK_ROW_PREFIX}{claim}"), None)
    if predecessor is None:
        raise cancellation_error("The named predecessor claim is missing; no query was canceled.")
    holder = _object_json(predecessor["holder"])
    recorded = _parse_identity(holder.get("queries"))
    if not _same_identity(recorded, identity):
        raise cancellation_error(
            "The predecessor is untracked, uses another SQL principal, "
            "or belongs to another topology."
        )
    _validate_intents(conn, target, identity, claim)
    prefix = f"{CANCELLATION_PREFIX}{claim}/"
    markers = _variants(conn, _source(target, identity), f"startsWith(name, {sql_string(prefix)})")
    if any(row["name"].endswith("/completed") for row in markers):
        raise cancellation_error(
            "This predecessor cancellation already completed. Name the actual newer "
            "stopped claim instead, or run ordinary apply."
        )
    return CancellationPlan(
        claim, predecessor["holder"], identity,
        any(row["name"].endswith("/pending") for row in markers),
    )


def assert_cancellation_unfinished(client: Any, target: LockTarget, plan: CancellationPlan) -> None:
    prefix = f"{CANCELLATION_PREFIX}{plan.claim}/"
    rows = _variants(
        _Control(client), _source(target, plan.identity),
        f"startsWith(name, {sql_string(prefix)})",
    )
    if (
        not any(row["name"].endswith("/pending") for row in rows)
        or any(row["name"].endswith("/completed") for row in rows)
    ):
        raise cancellation_error(
            "Cancellation is not durably unfinished; another owner may have admitted "
            "its own queries."
        )


def mark_cancellation_pending(client: Any, target: LockTarget, plan: CancellationPlan) -> None:
    _write_marker(client, target, plan, "pending")


def assert_cancellation_clear(
    client: Any,
    target: LockTarget,
    allowed_claim: str | None = None,
    identity: QueryIdentity | None = None,
) -> None:
    conn = _Control(
        client,
        fallback=not (
            callable(getattr(client, "query_control", None))
            and callable(getattr(client, "execute_tracked", None))
        ),
    )
    cluster_hint = getattr(client, "query_control_cluster", None)
    coverage = identity or (
        QueryIdentity(1, "", [], cluster_hint)
        if isinstance(cluster_hint, str) and cluster_hint
        else None
    )
    rows = _variants(
        conn, _source(target, coverage), f"startsWith(name, {sql_string(CANCELLATION_PREFIX)})"
    )
    markers: dict[str, str] = {}
    for row in rows:
        suffix = row["name"][len(CANCELLATION_PREFIX) :]
        claim, separator, phase = suffix.partition("/")
        if not separator or not _UUID.fullmatch(claim) or phase not in {"pending", "completed"}:
            raise cancellation_error("Malformed cancellation history; refusing migration work.")
        data = _object_json(row["checksum"])
        if (
            type(data.get("protocol")) is not int
            or data["protocol"] != 1
            or data.get("claim") != claim
        ):
            raise cancellation_error("Malformed cancellation marker; refusing migration work.")
        _parse_identity(data.get("identity"))
        markers[suffix] = row["checksum"]
    for name, checksum in markers.items():
        if not name.endswith("/pending"):
            continue
        claim = name.removesuffix("/pending")
        completed = markers.get(f"{claim}/completed")
        if completed is not None and completed != checksum:
            raise cancellation_error(
                "Conflicting cancellation completion history; refusing migration work."
            )
        if completed is None and claim != allowed_claim:
            raise cancellation_error(
                f"Cancellation of claim {claim} is unfinished. Stop its old CLI, then resume "
                f"with --apply --break-lock {claim} --cancel-lock-queries."
            )


def cancel_predecessor(
    client: Any,
    target: LockTarget,
    plan: CancellationPlan,
    lock: _LockCheck,
) -> None:
    conn = _Control(client, lock)
    identity, claim = plan.identity, plan.claim
    if len(identity.server_uuids) != 1:
        raise cancellation_error("Cancellation recovery requires a verified single server.")
    _assert_identity_topology(conn, identity)
    intents = _validate_intents(conn, target, identity, claim)
    ids = [intent["queryId"] for intent in intents]
    predicate = _process_predicate(identity, ids)
    from_ = f"clusterAllReplicas({sql_string(_require_cluster(identity))}, system.processes)"
    id_list = ",".join(sql_string(query_id) for query_id in ids)
    processes = conn.query(
        f"SELECT query_id, initial_query_id, user, initial_user FROM {from_} "
        f"WHERE query_id IN ({id_list}) OR initial_query_id IN ({id_list}) "
        "SETTINGS skip_unavailable_shards = 0"
    )
    for row in processes:
        if (row["query_id"] in ids and row["user"] != identity.principal) or (
            row["initial_query_id"] in ids and row["initial_user"] != identity.principal
        ):
            raise cancellation_error(
                "A recorded query id belongs to another SQL principal; no query was canceled."
            )
    try:
        conn.query(f"KILL QUERY WHERE {predicate} AND {_identity_guard(identity)} SYNC")
    except Exception as error:
        if not re.search(r"\bNOTHING_TO_KILL\b", str(error)):
            raise
    while True:
        _assert_identity_topology(conn, identity)
        running = conn.query(
            f"SELECT count() AS n FROM {from_} WHERE {predicate} "
            "SETTINGS skip_unavailable_shards = 0"
        )
        if len(running) != 1 or not _finite_number(running[0].get("n")):
            raise cancellation_error("Cannot verify query termination on every server.")
        if float(running[0]["n"]) == 0:
            break
        time.sleep(min(100, conn.remaining()) / 1000)
    lock.assert_held()
    _write_marker(client, target, plan, "completed", conn)
    lock.assert_held()


def _topology(conn: _Control, cluster: str) -> _Topology:
    snapshot_sql = (
        "SELECT host_name AS host, toString(port) AS port, toString(shard_num) AS shard, "
        "toString(replica_num) AS replica FROM system.clusters "
        f"WHERE cluster = {sql_string(cluster)} ORDER BY shard, replica, host, port"
    )
    before = conn.query(snapshot_sql)
    if not before:
        raise cancellation_error("The declared cancellation cluster is missing or unreadable.")
    nodes_sql = (
        "SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal "
        f"FROM clusterAllReplicas({sql_string(cluster)}, system.one) "
        "SETTINGS skip_unavailable_shards = 0"
    )
    local_sql = "SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal"
    local = conn.query(local_sql)
    nodes = conn.query(nodes_sql)
    after = conn.query(snapshot_sql)
    confirmed = conn.query(nodes_sql)
    local_after = conn.query(local_sql)
    uuids = sorted(row["server_uuid"] for row in nodes)
    principal = nodes[0].get("principal") if nodes else None
    hosts = sorted(f"{row['host']}:{row['port']}" for row in before)
    node_key = sorted(f"{row['server_uuid']}/{row['principal']}" for row in nodes)
    confirmed_key = sorted(f"{row['server_uuid']}/{row['principal']}" for row in confirmed)
    if (
        not principal
        or len(local) != 1
        or local[0].get("principal") != principal
        or local[0].get("server_uuid") not in uuids
        or local != local_after
        or len(nodes) != len(before)
        or len(set(uuids)) != len(before)
        or len(set(hosts)) != len(before)
        or any(not _UUID.fullmatch(value) for value in uuids)
        or any(row["principal"] != principal for row in nodes)
        or before != after
        or node_key != confirmed_key
    ):
        raise cancellation_error(
            "Cancellation cannot establish stable, complete same-principal replica coverage."
        )
    return _Topology(QueryIdentity(1, principal, uuids, cluster), hosts)


def _assert_identity_topology(conn: _Control, identity: QueryIdentity) -> _Topology:
    current = _topology(conn, _require_cluster(identity))
    if not _same_identity(current.identity, identity):
        raise cancellation_error(
            "The SQL principal or server topology changed; replacement work is blocked."
        )
    return current


def _validate_intents(
    conn: _Control,
    target: LockTarget,
    identity: QueryIdentity,
    claim: str,
) -> list[dict[str, Any]]:
    prefix = f"{QUERY_INTENT_PREFIX}{claim}/"
    rows = _variants(conn, _source(target, identity), f"startsWith(name, {sql_string(prefix)})")
    if not rows:
        raise cancellation_error("The predecessor has no cancellable tracked queries.")
    intents: list[dict[str, Any]] = []
    for row in rows:
        data = _object_json(row["checksum"])
        query_id = row["name"][len(prefix) :]
        recorded = _parse_identity(data)
        index = data.get("statementIndex")
        fingerprint = data.get("fingerprint")
        if (
            not _UUID.fullmatch(query_id)
            or data.get("queryId") != query_id
            or data.get("claim") != claim
            or not _same_identity(recorded, identity)
            or data.get("phase") not in ("forward", "compensation")
            or data.get("kind") not in ("insert", "truncate")
            or not isinstance(data.get("migration"), str)
            or not isinstance(index, int)
            or isinstance(index, bool)
            or index < 0
            or not isinstance(fingerprint, str)
            or not _FINGERPRINT.fullmatch(fingerprint)
        ):
            raise cancellation_error(
                "The predecessor contains unsupported, async or malformed query intents; "
                "no query was canceled."
            )
        table = data.get("target")
        if (
            not isinstance(table, dict)
            or not isinstance(table.get("database"), str)
            or not isinstance(table.get("name"), str)
            or not table["database"]
            or not table["name"]
        ):
            raise cancellation_error("A query intent has no valid SQL target.")
        metadata = conn.query(
            "SELECT engine, toJSONString(dependencies_table) AS dependencies "
            f"FROM clusterAllReplicas({sql_string(_require_cluster(identity))}, system.tables) "
            f"WHERE database = {sql_string(table['database'])} "
            f"AND name = {sql_string(table['name'])} "
            "SETTINGS skip_unavailable_shards = 0"
        )
        if len(metadata) != len(identity.server_uuids) or any(
            item["engine"] != "MergeTree" or item["dependencies"] != "[]" for item in metadata
        ):
            raise cancellation_error(
                "Cancellation currently requires plain MergeTree targets without "
                "materialized-view dependencies on every server."
            )
        intents.append(data)
    return intents


def _variants(conn: _Control, source: str, predicate: str) -> list[dict[str, str]]:
    rows = conn.query(
        f"SELECT name, toJSONString(groupUniqArray(checksum)) AS variants FROM {source} "
        f"WHERE {predicate} GROUP BY name "
        "SETTINGS skip_unavailable_shards = 0, select_sequential_consistency = 1"
    )
    result = []
    for row in rows:
        checksums = json.loads(row["variants"])
        if (
            not isinstance(checksums, list)
            or len(checksums) != 1
            or not isinstance(checksums[0], str)
        ):
            raise cancellation_error("Conflicting or unreadable immutable cancellation records.")
        result.append({"name": row["name"], "checksum": checksums[0]})
    return result


def _write_marker(
    client: Any,
    target: LockTarget,
    plan: CancellationPlan,
    phase: Literal["pending", "completed"],
    conn: _Control | None = None,
) -> None:
    conn = conn or _Control(client)
    name = f"{CANCELLATION_PREFIX}{plan.claim}/{phase}"
    checksum = json.dumps(
        {"protocol": 1, "claim": plan.claim, "identity": plan.identity.to_payload()},
        separators=(",", ":"),
        ensure_ascii=False,
    )
    conn.query(
        f"INSERT INTO {quote_identifier(target.database)}.{target.journal_table} "
        "(name, applied_at, checksum, chkit_version, migration_completed, operations) "
        f"SELECT {sql_string(name)}, now64(3), {sql_string(checksum)}, "
        f"{sql_string(__version__)}, false, [] "
        "SETTINGS async_insert = 0, insert_quorum = 'auto', insert_quorum_parallel = 0"
    )
    rows = _variants(conn, _source(target, plan.identity), f"name = {sql_string(name)}")
    if len(rows) != 1 or rows[0]["checksum"] != checksum:
        raise cancellation_error(
            f"Cancellation {phase} marker did not read back; replacement work is blocked."
        )


def _source(target: LockTarget, identity: QueryIdentity | None = None) -> str:
    cluster = identity.cluster if identity is not None else None
    if cluster is None and target.fanout is not None:
        cluster = target.fanout.cluster
    return (
        f"clusterAllReplicas({sql_string(cluster)}, {sql_string(target.database)}, "
        f"{sql_string(target.journal_table)})"
        if cluster
        else f"{quote_identifier(target.database)}.{target.journal_table}"
    )


def _identity_guard(identity: QueryIdentity) -> str:
    ids = ",".join(sql_string(value) for value in identity.server_uuids)
    return (
        f"throwIf(currentUser() != {sql_string(identity.principal)} "
        f"OR NOT has([{ids}], toString(serverUUID())), "
        "'Cancellation SQL identity or server mismatch') = 0"
    )


def _process_predicate(identity: QueryIdentity, ids: list[str]) -> str:
    id_list = ",".join(sql_string(query_id) for query_id in ids)
    return (
        f"((query_id IN ({id_list}) AND user = {sql_string(identity.principal)}) OR "
        f"(initial_query_id IN ({id_list}) AND initial_user = {sql_string(identity.principal)}))"
    )


def _parse_identity(value: Any) -> QueryIdentity:
    if not isinstance(value, dict):
        raise cancellation_error("Unsupported query tracking identity.")
    uuids, principal, cluster = (
        value.get("serverUUIDs"),
        value.get("principal"),
        value.get("cluster"),
    )
    if (
        type(value.get("protocol")) is not int
        or value["protocol"] != 1
        or not isinstance(principal, str)
        or not principal
        or not isinstance(uuids, list)
        or not uuids
        or any(not isinstance(item, str) or not _UUID.fullmatch(item) for item in uuids)
        or (cluster is not None and not isinstance(cluster, str))
    ):
        raise cancellation_error("Unsupported query tracking identity.")
    return QueryIdentity(1, principal, sorted(uuids), cluster)


def _same_identity(left: QueryIdentity, right: QueryIdentity) -> bool:
    return (
        left.principal == right.principal
        and left.cluster == right.cluster
        and sorted(left.server_uuids) == sorted(right.server_uuids)
    )


def _require_cluster(identity: QueryIdentity) -> str:
    if not identity.cluster:
        raise cancellation_error("Cancellation requires a verified declared cluster.")
    return identity.cluster


def _object_json(raw: str) -> dict[str, Any]:
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise cancellation_error("Malformed cancellation metadata.")
    return value


def _finite_number(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False
