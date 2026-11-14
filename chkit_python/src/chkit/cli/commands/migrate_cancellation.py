"""Verified cancellation of one stopped migrate holder's immutable query ids."""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field, replace
from types import SimpleNamespace
from typing import Any, Literal, Protocol

from chkit import __version__
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.commands.migrate_lock import (
    LOCK_ROW_PREFIX,
    LockTarget,
    claims_select_sql,
)
from chkit.cli.commands.migrate_query_intents import (
    QUERY_INTENT_PREFIX,
    UNTRACKED,
    QueryContext,
    QueryIdentity,
    QueryTarget,
    attest_query_table,
    cancellation_error,
    classify_query_intent,
    sql_string,
)
from chkit.clickhouse.replicas import ReplicaFanout
from chkit.core.identifier import quote_identifier
from chkit.core.sql_fingerprint import statement_fingerprint

RECOVERY_PREFIX = "__chkit_migrate_recovery__/"
CANCELLATION_PREFIX = "__chkit_migrate_cancel__/"
# `<prefix><old uuid>`: a recovery replaced that table; the row names its new UUID.
REPLACE_PREFIX = "__chkit_migrate_replace__/"
_LOGGER = logging.getLogger("chkit.migrate.queries")
_DEADLINE_MS = 30_000
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_FINGERPRINT = re.compile(r"^v1:[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class RecoveryObligation:
    migration: str
    statement_index: int
    forward_fingerprint: str
    target: QueryTarget
    source: QueryTarget | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "migration": self.migration,
            "statementIndex": self.statement_index,
            "forwardFingerprint": self.forward_fingerprint,
            "target": self.target.to_payload(),
            **({"source": self.source.to_payload()} if self.source is not None else {}),
        }


@dataclass(frozen=True, slots=True)
class RecoveryContext:
    protocol: Literal[1]
    claim: str
    identity: QueryIdentity
    parents: list[str]
    obligations: list[RecoveryObligation]

    def to_payload(self) -> dict[str, Any]:
        return {
            "protocol": self.protocol,
            "claim": self.claim,
            "identity": self.identity.to_payload(),
            "parents": self.parents,
            "obligations": [item.to_payload() for item in self.obligations],
        }


@dataclass(slots=True)
class _RecoveryRecord:
    context: RecoveryContext
    checksum: str
    completed: bool = False


@dataclass(frozen=True, slots=True)
class CancellationPlan:
    claim: str
    holder: str
    identity: QueryIdentity
    resume_pending: bool = False
    targets: list[QueryTarget] = field(default_factory=list)
    sources: list[QueryTarget] = field(default_factory=list)
    parents: list[str] = field(default_factory=list)
    obligations: list[RecoveryObligation] = field(default_factory=list)
    inherited: bool = False


@dataclass(slots=True)
class _Resolution:
    """How recorded target UUIDs map to live tables.

    Durable replace markers, the targets of recorded replaces whose marker may be
    missing (a crash right after the replace), and replacements this run adopted.
    """

    replaced: dict[str, str] = field(default_factory=dict)
    pending: set[str] = field(default_factory=set)
    adopted: dict[str, QueryTarget] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class _Topology:
    identity: QueryIdentity


class _LockCheck(Protocol):
    @property
    def claim_id(self) -> str: ...

    def assert_held(self) -> None: ...


class FreshRecoveryClient:
    """Fresh, complete decision reads for explicit recovery, including clones."""

    __slots__ = ("_client",)

    def __init__(self, client: Any) -> None:
        if not callable(getattr(client, "query_control", None)):
            raise cancellation_error("Explicit recovery requires bounded fresh control reads.")
        self._client = client

    def __getattr__(self, name: str) -> Any:
        if name == "query_status":
            raise cancellation_error(
                "Explicit recovery cannot attach historical async queries. "
                "Finish async recovery before using --cancel-lock-queries."
            )
        if name == "query":
            def query(statement: str, settings: dict[str, Any] | None = None) -> Any:
                return self._client.query_control(
                    statement, _DEADLINE_MS,
                    settings={**(settings or {}), "skip_unavailable_shards": 0},
                )

            return query
        value = getattr(self._client, name)
        if name == "open_concurrent" and callable(value):
            return lambda: FreshRecoveryClient(value())
        return value


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

    def query(
        self, sql: str, *, query_id: str | None = None, settings: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        if self._fallback:
            return list(self._client.query(sql).rows)
        options: dict[str, Any] = {}
        if query_id is not None:
            options["query_id"] = query_id
        if settings is not None:
            options["settings"] = settings
        rows = list(self._client.query_control(sql, self.remaining(), **options).rows)
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
    conn = _Control(client)
    _assert_identity_topology(conn, identity)
    history = _recovery_history(conn, target, identity)
    _assert_no_successor(history, claim)
    inherited = history.get(claim)
    if inherited is not None and inherited.completed:
        raise cancellation_error("This recovery completed; name the actual newer stopped claim.")
    if inherited is not None and not _same_identity(inherited.context.identity, identity):
        raise cancellation_error("Recovery belongs to another SQL identity or topology.")
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
    resolution = _read_resolution(conn, target, identity)
    intents = _validate_intents(
        conn, target, identity, claim, allow_empty=inherited is not None, resolution=resolution,
    )
    obligations = _unique_obligations(_validate_obligations(conn, identity, [
        *(inherited.context.obligations if inherited is not None else []),
        *_obligations_from_intents(intents),
    ], target, resolution))
    _assert_intents_covered(intents, obligations)
    _assert_replace_grants(conn, obligations)
    prefix = f"{CANCELLATION_PREFIX}{claim}/"
    markers = _variants(conn, _source(target, identity), f"startsWith(name, {sql_string(prefix)})")
    if any(row["name"].endswith("/completed") for row in markers):
        raise cancellation_error(
            "This predecessor cancellation already completed. Name the actual newer "
            "stopped claim instead, or run ordinary apply."
        )
    return CancellationPlan(
        claim, predecessor["holder"], identity,
        resume_pending=inherited is not None or any(
            row["name"].endswith("/pending") for row in markers
        ),
        targets=[item.target for item in obligations],
        sources=[item.source for item in obligations if item.source is not None],
        parents=inherited.context.parents if inherited is not None else [],
        obligations=obligations,
        inherited=inherited is not None,
    )


def expand_recovery_plan(
    client: Any, target: LockTarget, plan: CancellationPlan, contexts: list[QueryContext]
) -> CancellationPlan:
    """Attest the complete selected plan before breaking a claim or killing a query."""
    conn = _Control(client)
    additions: list[RecoveryObligation] = []
    metadata = SimpleNamespace(
        query_control=lambda sql, _timeout: SimpleNamespace(rows=conn.query(sql))
    )
    for context in contexts:
        classified = classify_query_intent(
            context.forward_sql, "forward", context.before_retry, target.database
        )
        if classified.kind != "insert" or classified.target is None:
            raise cancellation_error(
                "Recovery requires supported synchronous INSERT/replace pairs throughout "
                f"{context.migration}; no query was canceled."
            )
        table = attest_query_table(metadata, plan.identity, classified.target)
        source = (
            attest_query_table(metadata, plan.identity, classified.source)
            if classified.source is not None else None
        )
        obligation = RecoveryObligation(
            context.migration, context.statement_index,
            statement_fingerprint(context.forward_sql), table, source,
        )
        additions.extend(
            _validate_obligations(conn, plan.identity, [obligation], target, _Resolution())
        )
    for inherited in plan.obligations:
        if not any(
            item.migration == inherited.migration
            and item.statement_index == inherited.statement_index for item in additions
        ):
            _assert_journal_coverage(conn, target, plan.identity, [inherited])
    obligations = _unique_obligations([*plan.obligations, *additions])
    _assert_replace_grants(conn, obligations)
    return replace(
        plan, obligations=obligations, targets=[item.target for item in obligations],
        sources=[item.source for item in obligations if item.source is not None],
    )


def assert_cancellation_unfinished(
    client: Any, target: LockTarget, plan: CancellationPlan,
    reservations: list[dict[str, str]] | None = None,
) -> None:
    conn = _Control(client)
    history = _recovery_history(conn, target, plan.identity)
    _assert_no_successor(history, plan.claim)
    prefix = f"{CANCELLATION_PREFIX}{plan.claim}/"
    rows = _variants(
        conn, _source(target, plan.identity), f"startsWith(name, {sql_string(prefix)})"
    )
    if any(row["name"].endswith("/completed") for row in rows):
        raise cancellation_error(
            "Cancellation completed; another owner may have admitted its own queries."
        )
    if any(row["name"].endswith("/pending") for row in rows):
        return
    inherited = history.get(plan.claim)
    if (inherited is not None and inherited.completed) or not reservations:
        raise cancellation_error(
            "Cancellation is not durably unfinished; another owner may have admitted "
            "its own queries."
        )
    for reservation in reservations:
        holder = _object_json(reservation["holder"])
        if (
            holder.get("recoveryOf") != plan.claim
            or not _same_identity(_parse_identity(holder.get("queries")), plan.identity)
            or reservation["claim"] in history
        ):
            raise cancellation_error("A competing claim is not a linked reservation-only recovery.")
        if _validate_intents(
            conn, target, plan.identity, reservation["claim"], allow_empty=True,
            resolution=_read_resolution(conn, target, plan.identity),
        ):
            raise cancellation_error(
                "A competing recovery already recorded migration work; name its actual claim."
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
    history = _recovery_history(conn, target, coverage)
    allowed = history.get(allowed_claim) if allowed_claim is not None else None
    ancestors = allowed.context.parents if allowed is not None and not allowed.completed else []
    for claim, record in history.items():
        if not record.completed and claim != allowed_claim and claim not in ancestors:
            successor = _newest_required(history, claim)
            raise cancellation_error(
                f"Recovery of claim {successor} is unfinished. Stop that CLI, then resume "
                f"with --apply --break-lock {successor} --cancel-lock-queries."
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
        if completed is None and claim != allowed_claim and claim not in ancestors:
            raise cancellation_error(
                f"Cancellation of claim {claim} is unfinished. Stop its old CLI, then resume "
                f"with --apply --break-lock {claim} --cancel-lock-queries."
            )


def cancel_predecessor(
    client: Any, target: LockTarget, plan: CancellationPlan, lock: _LockCheck,
) -> RecoveryContext:
    """No compensation or replacement statement may run until this returns.

    The KILL only frees the server: the replace of each target is what keeps a
    stopped statement from storing rows (#732).
    """
    conn = _Control(client, lock)
    identity, claim = plan.identity, plan.claim
    _assert_identity_topology(conn, identity)
    history = _recovery_history(conn, target, identity)
    _assert_no_successor(history, claim)
    if plan.inherited and claim not in history:
        raise cancellation_error("The inherited recovery context disappeared.")
    resolution = _read_resolution(conn, target, identity)
    intents = _validate_intents(
        conn, target, identity, claim, allow_empty=plan.inherited, resolution=resolution,
    )
    obligations = _unique_obligations(
        _validate_obligations(conn, identity, plan.obligations, target, resolution)
    )
    _assert_intents_covered(intents, obligations)
    ids = [intent["queryId"] for intent in intents]
    if ids:
        id_list = ",".join(sql_string(query_id) for query_id in ids)
        processes = conn.query(
            "SELECT query_id, initial_query_id, user, initial_user FROM "
            f"clusterAllReplicas({sql_string(_require_cluster(identity))}, system.processes) "
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
        _kill_recorded_queries(conn, identity, ids)
    # A recorded replace whose marker the stopped run never wrote: record the
    # UUID it left, so every later read resolves the same table.
    for from_uuid, table in resolution.adopted.items():
        _write_replace_marker(conn, target, identity, from_uuid, table)
    lock.assert_held()
    active_claim = lock.claim_id
    if not active_claim or not _UUID.fullmatch(active_claim):
        raise cancellation_error("The replacement lock has no valid claim identity.")
    context = RecoveryContext(
        1, active_claim, identity, sorted({claim, *plan.parents}), obligations
    )
    # Durable successor ownership precedes ancestor completion and every user send.
    _write_recovery_marker(conn, target, context, "required")
    for ancestor in context.parents:
        cancellation_rows = _variants(
            conn, _source(target, identity),
            f"name = {sql_string(f'{CANCELLATION_PREFIX}{ancestor}/pending')}",
        )
        if ancestor == claim or cancellation_rows:
            _write_marker(client, target, replace(plan, claim=ancestor), "completed", conn)
        previous = history.get(ancestor)
        if previous is not None and not previous.completed:
            _write_recovery_marker(conn, target, previous.context, "completed")
    lock.assert_held()
    return context


def finish_recovery(
    client: Any, target: LockTarget, context: RecoveryContext, lock: _LockCheck,
) -> None:
    """Release the barrier only after durable journal proof covers the entire plan."""
    conn = _Control(client, lock)
    _assert_identity_topology(conn, context.identity)
    resolution = _read_resolution(conn, target, context.identity)
    own_intents = _validate_intents(
        conn, target, context.identity, context.claim, allow_empty=True, resolution=resolution,
    )
    obligations = _unique_obligations(_validate_obligations(conn, context.identity, [
        *context.obligations, *_obligations_from_intents(own_intents)
    ], target, resolution))
    _assert_journal_coverage(conn, target, context.identity, obligations)
    _write_recovery_marker(conn, target, context, "completed")


def _assert_journal_coverage(
    conn: _Control, target: LockTarget, identity: QueryIdentity,
    obligations: list[RecoveryObligation],
) -> None:
    names = list(dict.fromkeys(item.migration for item in obligations))
    rows = conn.query(
        "SELECT name, toString(toUInt8(latest.1)) AS migration_completed, "
        "toJSONString(arrayMap((op, fp) -> tuple(op.operation_index, op.status, fp), "
        "latest.2, latest.3)) AS operations FROM (SELECT name, "
        "argMax(tuple(migration_completed, operations, operation_fingerprints), applied_at) "
        f"AS latest FROM {_source(target, identity)} WHERE name IN "
        f"({','.join(sql_string(name) for name in names)}) GROUP BY name) "
        "SETTINGS skip_unavailable_shards = 0, select_sequential_consistency = 1"
    )
    for obligation in obligations:
        row = next((item for item in rows if item["name"] == obligation.migration), None)
        operations = json.loads(row["operations"]) if row is not None else None
        if (
            row is None or row["migration_completed"] != "1"
            or not isinstance(operations, list)
            or not any(
                isinstance(op, list) and len(op) >= 3  # noqa: PLR2004 — journal tuple shape
                and type(op[0]) is int and op[0] == obligation.statement_index
                and op[1] == "completed" and op[2] == obligation.forward_fingerprint
                for op in operations
            )
        ):
            raise cancellation_error(
                f"Recovery still requires {obligation.migration} statement "
                f"{obligation.statement_index + 1}. Restore its unchanged SQL and include "
                "it in apply; the recovery barrier remains."
            )


def _kill_recorded_queries(conn: _Control, identity: QueryIdentity, ids: list[str]) -> None:
    """Local KILLs, one per declared member, so a round-robin endpoint reaches each. Best effort."""
    for _member in identity.server_uuids:
        try:
            conn.query(f"KILL QUERY WHERE {_process_predicate(identity, ids)} ASYNC")
        except MigrateError:
            raise
        except Exception as error:  # the replace, not the KILL, is the gate
            _LOGGER.debug("KILL failed: %s", error)


def _assert_replace_grants(conn: _Control, obligations: list[RecoveryObligation]) -> None:
    """The replace needs CREATE TABLE and DROP TABLE on each target, directly or via roles."""
    rows = conn.query(
        "SELECT access_type, database, table, is_partial_revoke FROM system.grants "
        "WHERE (user_name = currentUser() OR role_name IN "
        "(SELECT role_name FROM system.enabled_roles)) AND access_type IN "
        "('ALL', 'CREATE', 'CREATE TABLE', 'DROP', 'DROP TABLE') AND column IS NULL"
    )

    def covers(row: dict[str, Any], table: QueryTarget) -> bool:
        return (row.get("database") in (None, table.database)
                and row.get("table") in (None, table.name))

    def allowed(access: set[str], table: QueryTarget) -> bool:
        matching = [row for row in rows if row.get("access_type") in access and covers(row, table)]
        return (any(not _is_true(row.get("is_partial_revoke")) for row in matching)
                and not any(_is_true(row.get("is_partial_revoke")) for row in matching))

    for obligation in obligations:
        table = obligation.target
        if not allowed({"ALL", "CREATE", "CREATE TABLE"}, table) or not allowed(
            {"ALL", "DROP", "DROP TABLE"}, table
        ):
            raise cancellation_error(
                f"Recovery replaces {table.database}.{table.name}, which needs "
                "CREATE TABLE and DROP TABLE on it."
            )


def _is_true(value: Any) -> bool:
    return value is True or value == 1 or value in ("1", "true")


def _topology(conn: _Control, cluster: str) -> _Topology:
    nodes_sql = (
        "SELECT server_uuid, principal FROM clusterAllReplicas("
        f"{sql_string(cluster)}, view(SELECT toString(serverUUID()) AS server_uuid, "
        "currentUser() AS principal FROM system.one)) SETTINGS skip_unavailable_shards = 0"
    )
    local_sql = "SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal"
    nodes = conn.query(nodes_sql)
    local = conn.query(local_sql)
    confirmed = conn.query(nodes_sql)
    local_after = conn.query(local_sql)
    uuids = sorted(row["server_uuid"] for row in nodes)
    principal = nodes[0].get("principal") if nodes else None
    node_key = sorted(f"{row['server_uuid']}/{row['principal']}" for row in nodes)
    confirmed_key = sorted(f"{row['server_uuid']}/{row['principal']}" for row in confirmed)
    if (
        not principal
        or not nodes
        or len(set(uuids)) != len(nodes)
        or any(not _UUID.fullmatch(value) for value in uuids)
        or any(row["principal"] != principal for row in nodes)
        or node_key != confirmed_key
        or any(
            len(rows) != 1
            or rows[0].get("principal") != principal
            or rows[0].get("server_uuid") not in uuids
            for rows in (local, local_after)
        )
    ):
        raise cancellation_error(
            "Cancellation cannot establish stable, complete same-principal replica coverage."
        )
    return _Topology(QueryIdentity(1, principal, uuids, cluster))


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
    *,
    allow_empty: bool,
    resolution: _Resolution,
) -> list[dict[str, Any]]:
    prefix = f"{QUERY_INTENT_PREFIX}{claim}/"
    rows = _variants(conn, _source(target, identity), f"startsWith(name, {sql_string(prefix)})")
    if not rows and not allow_empty:
        raise cancellation_error("The predecessor has no cancellable tracked queries.")
    if any(row["name"] == f"{prefix}{UNTRACKED}" for row in rows):
        raise cancellation_error(
            "The predecessor ran statements chkit could not track, so it cannot be cancelled. "
            "Stop it and recover by hand."
        )
    parsed = [(row["name"][len(prefix):], _object_json(row["checksum"])) for row in rows]
    # A recorded replace may have run without its marker: its target can have a new UUID.
    for _query_id, data in parsed:
        table = data.get("target")
        if data.get("phase") == "compensation" and isinstance(table, dict) and isinstance(
            table.get("uuid"), str
        ):
            resolution.pending.add(_resolve_uuid(resolution, table["uuid"]))
    intents: list[dict[str, Any]] = []
    for query_id, data in parsed:
        recorded = _parse_identity(data)
        index = data.get("statementIndex")
        fingerprint = data.get("fingerprint")
        forward_fingerprint = data.get("forwardFingerprint")
        if (
            not _UUID.fullmatch(query_id)
            or data.get("queryId") != query_id
            or data.get("claim") != claim
            or not _same_identity(recorded, identity)
            or data.get("phase") not in ("forward", "compensation")
            or data.get("kind") != ("insert" if data.get("phase") == "forward" else "replace")
            or not isinstance(data.get("migration"), str)
            or not isinstance(index, int)
            or isinstance(index, bool)
            or index < 0
            or not isinstance(fingerprint, str)
            or not _FINGERPRINT.fullmatch(fingerprint)
            or not isinstance(forward_fingerprint, str)
            or not _FINGERPRINT.fullmatch(forward_fingerprint)
            or (data.get("phase") == "forward" and fingerprint != forward_fingerprint)
        ):
            raise cancellation_error(
                "The predecessor contains unsupported, async or malformed query intents; "
                "no query was canceled."
            )
        _assert_not_journal(target, _recorded_table(data.get("target")))
        if "source" in data:
            _assert_not_journal(target, _recorded_table(data["source"]))
        table = _validate_table(
            conn, identity, data.get("target"), source_table=False, resolution=resolution,
        )
        source = (
            _validate_table(
            conn, identity, data["source"], source_table=True, resolution=resolution,
        )
            if "source" in data else None
        )
        if source is not None and source.uuid == table.uuid:
            raise cancellation_error(
                "The compensation would replace its own source; replacement work is blocked."
            )
        intents.append({
            **data, "target": table.to_payload(),
            **({"source": source.to_payload()} if source is not None else {}),
        })
    return intents


def _table_rows(
    conn: _Control, identity: QueryIdentity, database: str, name: str,
) -> list[dict[str, Any]]:
    return conn.query(
        "SELECT server_uuid, principal, uuid, engine, dependencies, database_engine "
        f"FROM clusterAllReplicas({sql_string(_require_cluster(identity))}, view("
        "SELECT toString(serverUUID()) AS server_uuid, "
        "currentUser() AS principal, toString(uuid) AS uuid, engine, "
        "toJSONString(dependencies_table) AS dependencies, "
        f"(SELECT any(engine) FROM system.databases WHERE name = {sql_string(database)}) "
        f"AS database_engine FROM system.tables WHERE database = {sql_string(database)} "
        f"AND name = {sql_string(name)})) SETTINGS skip_unavailable_shards = 0"
    )


def _same_members(rows: list[dict[str, Any]], identity: QueryIdentity) -> bool:
    return sorted(row["server_uuid"] for row in rows) == sorted(identity.server_uuids)


def _validate_table(
    conn: _Control, identity: QueryIdentity, value: Any, *, source_table: bool,
    resolution: _Resolution,
) -> QueryTarget:
    """The live table a recorded one stands for now, refusing any change recovery did not make."""
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("database"), str)
        or not value["database"]
        or not isinstance(value.get("name"), str)
        or not value["name"]
    ):
        raise cancellation_error("A query intent has no valid SQL table.")
    if (
        not isinstance(value.get("uuid"), str)
        or not _UUID.fullmatch(value["uuid"])
        or value["uuid"] == "00000000-0000-0000-0000-000000000000"
        or not isinstance(value.get("engine"), str)
    ):
        raise cancellation_error("A table source or target has no recorded storage identity.")
    metadata = _table_rows(conn, identity, value["database"], value["name"])
    engines = (
        {"MergeTree", "ReplicatedMergeTree", "SharedMergeTree"}
        if source_table
        else {"MergeTree", "SharedMergeTree"}
    )
    if (
        len(metadata) != len(identity.server_uuids)
        or any(row["engine"] not in engines or row["dependencies"] != "[]" for row in metadata)
        or (not source_table and value["engine"] == "MergeTree" and len(identity.server_uuids) != 1)
    ):
        raise cancellation_error(
            "Cancellation requires a plain MergeTree target on one declared server, or a "
            "SharedMergeTree target, without materialized-view dependencies."
        )
    if not source_table and any(
        row.get("database_engine") not in ("Atomic", "Shared") for row in metadata
    ):
        raise cancellation_error(
            "Recovery replaces its targets, which needs an Atomic or Shared database."
        )
    expected = value["uuid"] if source_table else _resolve_uuid(resolution, value["uuid"])
    live = str(metadata[0]["uuid"]) if metadata else ""
    adopted = (
        not source_table and live != expected and expected in resolution.pending
        and bool(_UUID.fullmatch(live))
    )
    if not _same_members(metadata, identity) or any(
        row["principal"] != identity.principal
        or row["uuid"] != (live if adopted else expected)
        or row["engine"] != value["engine"]
        for row in metadata
    ):
        raise cancellation_error(
            "A recorded source or target identity changed; replacement work is blocked."
        )
    table = QueryTarget(
        value["database"], value["name"], live if adopted else expected, value["engine"]
    )
    if adopted:
        resolution.adopted[expected] = table
    return table


def settle_compensation(
    client: Any, target: LockTarget, plan: CancellationPlan, table: QueryTarget,
    lock: _LockCheck,
) -> QueryTarget:
    """Wait until every replica serves the new, empty table, then record its new UUID (#732)."""
    conn = _Control(client, lock)
    _assert_identity_topology(conn, plan.identity)
    if table.uuid is None:
        raise cancellation_error("Compensation has no recorded table identity.")
    replaced: QueryTarget | None = None
    while replaced is None:
        rows = _table_rows(conn, plan.identity, table.database, table.name)
        uuid = rows[0].get("uuid") if rows else None
        if (
            _same_members(rows, plan.identity) and uuid and uuid != table.uuid
            and all(row["uuid"] == uuid for row in rows)
        ):
            if any(
                row["principal"] != plan.identity.principal or row["engine"] != table.engine
                or row["dependencies"] != "[]" for row in rows
            ):
                raise cancellation_error(
                    "The replaced table changed engine or gained dependencies; reload is blocked."
                )
            replaced = QueryTarget(table.database, table.name, str(uuid), table.engine)
        else:
            time.sleep(min(100, conn.remaining()) / 1000)
    _write_replace_marker(conn, target, plan.identity, table.uuid, replaced)
    lock.assert_held()
    return replaced


def _write_replace_marker(
    conn: _Control, target: LockTarget, identity: QueryIdentity, from_uuid: str,
    table: QueryTarget,
) -> None:
    name = f"{REPLACE_PREFIX}{from_uuid}"
    checksum = json.dumps(
        {"protocol": 1, "from": from_uuid, **table.to_payload()},
        separators=(",", ":"), ensure_ascii=False,
    )
    conn.query(
        f"INSERT INTO {quote_identifier(target.database)}.{target.journal_table} "
        "(name, applied_at, checksum, chkit_version, migration_completed, operations) "
        f"SELECT {sql_string(name)}, now64(3), {sql_string(checksum)}, "
        f"{sql_string(__version__)}, false, [] "
        "SETTINGS async_insert = 0, insert_quorum = 'auto', insert_quorum_parallel = 0"
    )
    rows = _variants(conn, _source(target, identity), f"name = {sql_string(name)}")
    if len(rows) != 1 or rows[0]["checksum"] != checksum:
        raise cancellation_error("The replace marker did not read back; reload is blocked.")


def _read_resolution(conn: _Control, target: LockTarget, identity: QueryIdentity) -> _Resolution:
    resolution = _Resolution()
    rows = _variants(
        conn, _source(target, identity), f"startsWith(name, {sql_string(REPLACE_PREFIX)})"
    )
    for row in rows:
        from_uuid = row["name"][len(REPLACE_PREFIX):]
        data = _object_json(row["checksum"])
        to = _recorded_table(data)
        if (
            not _UUID.fullmatch(from_uuid) or type(data.get("protocol")) is not int
            or data["protocol"] != 1 or data.get("from") != from_uuid or to.uuid == from_uuid
        ):
            raise cancellation_error("Malformed replace history.")
        resolution.replaced[from_uuid] = str(to.uuid)
    return resolution


def _resolve_uuid(resolution: _Resolution, value: str) -> str:
    """The UUID a recorded one resolves to through durable replace markers."""
    seen: set[str] = set()
    current = value
    while current in resolution.replaced:
        if current in seen:
            raise cancellation_error("Cyclic replace history.")
        seen.add(current)
        current = resolution.replaced[current]
    return current


def _recovery_history(
    conn: _Control, target: LockTarget, identity: QueryIdentity | None = None,
) -> dict[str, _RecoveryRecord]:
    rows = _variants(
        conn, _source(target, identity), f"startsWith(name, {sql_string(RECOVERY_PREFIX)})"
    )
    required: dict[str, _RecoveryRecord] = {}
    completed: dict[str, str] = {}
    for row in rows:
        claim, separator, phase = row["name"][len(RECOVERY_PREFIX):].partition("/")
        if not separator or not _UUID.fullmatch(claim) or phase not in {"required", "completed"}:
            raise cancellation_error("Malformed recovery history.")
        context = _parse_recovery_context(_object_json(row["checksum"]))
        if context.claim != claim:
            raise cancellation_error("Conflicting recovery claim identity.")
        if phase == "required":
            required[claim] = _RecoveryRecord(context, row["checksum"])
        else:
            completed[claim] = row["checksum"]
    for claim, checksum in completed.items():
        record = required.get(claim)
        if record is None or record.checksum != checksum:
            raise cancellation_error("Conflicting recovery completion history.")
        record.completed = True
    for record in required.values():
        for parent in record.context.parents:
            ancestor = required.get(parent)
            if ancestor is not None and (
                not _same_identity(ancestor.context.identity, record.context.identity)
                or record.context.claim in ancestor.context.parents
            ):
                raise cancellation_error("Conflicting or cyclic recovery ancestry.")
    return required


def _parse_recovery_context(data: dict[str, Any]) -> RecoveryContext:
    parents, claim, values = data.get("parents"), data.get("claim"), data.get("obligations")
    if (
        type(data.get("protocol")) is not int or data["protocol"] != 1
        or not isinstance(claim, str) or not _UUID.fullmatch(claim)
        or not isinstance(parents, list) or not parents
        or any(not isinstance(parent, str) or not _UUID.fullmatch(parent) or parent == claim
               for parent in parents)
        or parents != sorted(set(parents))
        or not isinstance(values, list) or not values
    ):
        raise cancellation_error("Malformed inherited recovery context.")
    identity = _parse_identity(data.get("identity"))
    obligations: list[RecoveryObligation] = []
    for value in values:
        if (
            not isinstance(value, dict)
            or not isinstance(value.get("migration"), str) or not value["migration"]
            or type(value.get("statementIndex")) is not int or value["statementIndex"] < 0
            or not isinstance(value.get("forwardFingerprint"), str)
            or not _FINGERPRINT.fullmatch(value["forwardFingerprint"])
        ):
            raise cancellation_error("Malformed recovery obligation.")
        obligations.append(RecoveryObligation(
            value["migration"], value["statementIndex"], value["forwardFingerprint"],
            _recorded_table(value.get("target")),
            _recorded_table(value["source"]) if "source" in value else None,
        ))
    return RecoveryContext(1, claim, identity, parents, _unique_obligations(obligations))


def _recorded_table(value: Any) -> QueryTarget:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("database"), str) or not value["database"]
        or not isinstance(value.get("name"), str) or not value["name"]
        or not isinstance(value.get("uuid"), str) or not _UUID.fullmatch(value["uuid"])
        or value["uuid"] == "00000000-0000-0000-0000-000000000000"
        or not isinstance(value.get("engine"), str)
    ):
        raise cancellation_error("Malformed recovery table identity.")
    return QueryTarget(value["database"], value["name"], value["uuid"], value["engine"])


def _obligations_from_intents(intents: list[dict[str, Any]]) -> list[RecoveryObligation]:
    return _unique_obligations([
        RecoveryObligation(
            item["migration"], item["statementIndex"], item["forwardFingerprint"],
            _recorded_table(item.get("target")),
            _recorded_table(item["source"]) if "source" in item else None,
        ) for item in intents
    ])


def _unique_obligations(obligations: list[RecoveryObligation]) -> list[RecoveryObligation]:
    result: dict[tuple[str, int], RecoveryObligation] = {}
    for obligation in obligations:
        key = (obligation.migration, obligation.statement_index)
        previous = result.get(key)
        if previous is not None and previous != obligation:
            raise cancellation_error("Conflicting recovery obligations for a statement.")
        result[key] = obligation
    values = list(result.values())
    targets: set[str] = set()
    for item in values:
        if item.target.uuid is None or item.target.uuid in targets:
            raise cancellation_error(
                "Recovery requires a distinct compensation target per statement."
            )
        targets.add(item.target.uuid)
    if any(item.source is not None and item.source.uuid in targets for item in values):
        raise cancellation_error("A compensation would mutate another statement's frozen source.")
    return sorted(values, key=lambda item: (item.migration, item.statement_index))


def _assert_intents_covered(
    intents: list[dict[str, Any]], obligations: list[RecoveryObligation],
) -> None:
    for intent in intents:
        if _obligations_from_intents([intent])[0] not in obligations:
            raise cancellation_error(
                "A successor admitted work outside its inherited recovery context."
            )


def _validate_obligations(
    conn: _Control, identity: QueryIdentity, obligations: list[RecoveryObligation],
    journal: LockTarget, resolution: _Resolution,
) -> list[RecoveryObligation]:
    """Each obligation with its tables resolved to the live ones."""
    if not obligations:
        raise cancellation_error("Recovery has no complete forward obligations.")
    validated: list[RecoveryObligation] = []
    for item in obligations:
        _assert_not_journal(journal, item.target)
        if item.source is not None:
            _assert_not_journal(journal, item.source)
        table = _validate_table(
            conn, identity, item.target.to_payload(), source_table=False, resolution=resolution,
        )
        source = (
            _validate_table(
            conn, identity, item.source.to_payload(), source_table=True, resolution=resolution,
        )
            if item.source is not None else None
        )
        validated.append(RecoveryObligation(
            item.migration, item.statement_index, item.forward_fingerprint, table, source,
        ))
    return validated


def _assert_not_journal(journal: LockTarget, table: QueryTarget) -> None:
    if table.database == journal.database and table.name == journal.journal_table:
        raise cancellation_error("The migration journal cannot be a recovery target or source.")


def _newest_required(history: dict[str, _RecoveryRecord], claim: str) -> str:
    descendants = [
        record for record in history.values()
        if not record.completed and claim in record.context.parents
    ]
    leaves = [
        record for record in descendants
        if not any(record.context.claim in other.context.parents for other in descendants)
    ]
    if len(leaves) > 1:
        raise cancellation_error(
            "Several unresolved successor recoveries exist; migration work is blocked."
        )
    return leaves[0].context.claim if leaves else claim


def _assert_no_successor(history: dict[str, _RecoveryRecord], claim: str) -> None:
    newest = _newest_required(history, claim)
    if newest != claim:
        raise cancellation_error(
            f"Claim {claim} handed recovery to {newest}. Stop that CLI, then use "
            f"--apply --break-lock {newest} --cancel-lock-queries."
        )


def _write_recovery_marker(
    conn: _Control, target: LockTarget, context: RecoveryContext,
    phase: Literal["required", "completed"],
) -> None:
    name = f"{RECOVERY_PREFIX}{context.claim}/{phase}"
    checksum = json.dumps(context.to_payload(), separators=(",", ":"), ensure_ascii=False)
    conn.query(
        f"INSERT INTO {quote_identifier(target.database)}.{target.journal_table} "
        "(name, applied_at, checksum, chkit_version, migration_completed, operations) "
        f"SELECT {sql_string(name)}, now64(3), {sql_string(checksum)}, "
        f"{sql_string(__version__)}, false, [] "
        "SETTINGS async_insert = 0, insert_quorum = 'auto', insert_quorum_parallel = 0"
    )
    rows = _variants(conn, _source(target, context.identity), f"name = {sql_string(name)}")
    if len(rows) != 1 or rows[0]["checksum"] != checksum:
        raise cancellation_error(
            f"Recovery {phase} marker did not read back; replacement work is blocked."
        )


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

