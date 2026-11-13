"""Fault injection for durable cancellation and refusal before replacement work."""

from __future__ import annotations

import json
import re
import time
from dataclasses import replace
from typing import Any
from uuid import UUID

import pytest

from chkit.cli.commands import migrate_cancellation
from chkit.cli.commands.migrate_cancellation import (
    CANCELLATION_PREFIX,
    RECOVERY_PREFIX,
    _Control,
    assert_cancellation_clear,
    assert_cancellation_unfinished,
    cancel_predecessor,
    expand_recovery_plan,
    finish_recovery,
    kill_with_receipts,
    mark_cancellation_pending,
    prepare_cancellation,
    resolve_query_identity,
    settle_compensation,
)
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.commands.migrate_lock import LockTarget
from chkit.cli.commands.migrate_query_intents import (
    QUERY_INTENT_PREFIX,
    QueryContext,
    QueryIdentity,
)
from chkit.clickhouse.client import QueryResult
from chkit.core.sql_fingerprint import statement_fingerprint

CLAIM = "00000000-0000-4000-8000-000000000001"
QUERY_ID = "00000000-0000-4000-8000-000000000002"
SUCCESSOR = "00000000-0000-4000-8000-000000000005"
NEXT = "00000000-0000-4000-8000-000000000007"
SOURCE = "00000000-0000-4000-8000-000000000006"
SERVER = "00000000-0000-4000-8000-000000000003"
IDENTITY = QueryIdentity(1, "writer", [SERVER], "declared")
TARGET = LockTarget("app", "_chkit_migrations", None)


class ControlFixture:
    query_control_cluster = "declared"

    def __init__(self, identity: QueryIdentity = IDENTITY) -> None:
        self.identity = identity
        self.claim_id = SUCCESSOR
        self.journal_completed = False
        self.journal_operations: list[list[Any]] = []
        self.fail_required = ""
        self.fail_recovery_completion = ""
        self.recorded_engine = "MergeTree"
        self.capability = 1
        self.capability_overrides: list[int] = []
        self.capability_error = False
        self.parts = 0
        self.parts_reads = 0
        self.source = False
        self.source_uuid = SOURCE
        self.source_engine = "MergeTree"
        self.intents: dict[str, list[dict[str, Any]]] = {}
        self.markers: dict[str, str] = {}
        self.calls: list[tuple[str, float]] = []
        self.kind = "insert"
        self.engine = "MergeTree"
        self.dependencies = "[]"
        self.principal = "writer"
        self.server = SERVER
        self.local_server = SERVER
        self.local_principal = "writer"
        self.kill_failure = False
        self.fail_completion = False
        self.held = True
        self.killed = False
        self.unreadable = False
        self.legacy = False
        self.controls: list[str] = []
        self.servers: list[str] | None = identity.server_uuids if len(identity.server_uuids) > 1 else None
        self.receipt_rows: list[dict[str, Any]] | None = None
        self.receipt_error = False
        self.fingerprint = statement_fingerprint("INSERT INTO app.events SELECT 1")

    def execute_tracked(self, *_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("No replacement SQL belongs in cancellation preflight")

    def assert_held(self) -> None:
        if not self.held:
            raise RuntimeError("lost ownership")

    def query_control(self, sql: str, timeout_ms: float, *, query_id: str | None = None, settings: dict[str, Any] | None = None) -> QueryResult:  # noqa: PLR0911, PLR0912, PLR0915
        """Dispatch the scripted SQL protocol, including forced failure branches."""
        self.calls.append((sql, timeout_ms))
        if self.unreadable:
            raise RuntimeError("replica unreadable")
        if "FROM system.clusters" in sql:
            return self._rows([{"host": "host", "port": "9000", "shard": "1", "replica": "1"}])
        if "serverUUID()" in sql and "clusterAllReplicas" not in sql and sql.startswith("SELECT"):
            return self._rows([{"server_uuid": self.local_server, "principal": self.local_principal}])
        if "sharedMergeTreeTruncateFenceVersion" in sql:
            if self.capability_error:
                raise RuntimeError("UNKNOWN_FUNCTION")
            return self._rows([{"server_uuid": server, "principal": self.principal,
                               "version": self.capability_overrides[index] if index < len(self.capability_overrides) else self.capability}
                              for index, server in enumerate(self.servers or [self.server])])
        if "system.one" in sql:
            return self._rows([{"server_uuid": server, "principal": self.principal} for server in (self.servers or [self.server])])
        if "argMax(tuple(applied_at" in sql:
            return self._rows([{
                "name": f"__chkit_migrate_lock__/{claim}",
                "holder": json.dumps({} if self.legacy else {"queries": self.identity.to_payload()}),
            } for claim in (CLAIM, SUCCESSOR, NEXT)])
        if sql.startswith("INSERT INTO"):
            match = re.search(r"SELECT '([^']+)', now64\(3\), '((?:[^'\\]|\\.)*)'", sql)
            assert match is not None, "unexpected marker INSERT"
            if self.fail_completion and match[1].endswith("/completed"):
                raise RuntimeError("completion unavailable")
            required = match[1].startswith(RECOVERY_PREFIX) and match[1].endswith("/required")
            completed = match[1].startswith(RECOVERY_PREFIX) and match[1].endswith("/completed")
            if required and self.fail_required == "before":
                raise RuntimeError("required absent")
            self.markers[match[1]] = re.sub(r"\\(.)", r"\1", match[2])
            if required and self.fail_required == "after":
                raise RuntimeError("required ACK lost")
            if completed and self.fail_recovery_completion == "after":
                raise RuntimeError("recovery completion ACK lost")
            return self._rows([])
        if "groupUniqArray(checksum)" in sql:
            if QUERY_INTENT_PREFIX in sql:
                claim = next((value for value in (CLAIM, SUCCESSOR, NEXT)
                              if f"{QUERY_INTENT_PREFIX}{value}/" in sql), "")
                intent = {
                    **self.identity.to_payload(), "claim": CLAIM, "queryId": QUERY_ID,
                    "migration": "load.sql", "statementIndex": 0, "phase": "forward",
                    "kind": self.kind, "fingerprint": self.fingerprint,
                    "forwardFingerprint": self.fingerprint,
                    "target": {"database": "app", "name": "events", "uuid": QUERY_ID, "engine": self.recorded_engine},
                    **({"source": {"database": "app", "name": "frozen", "uuid": SOURCE, "engine": "MergeTree"}} if self.source else {}),
                }
                own = [intent] if claim == CLAIM else self.intents.get(claim, [])
                return self._rows([{
                    "name": f"{QUERY_INTENT_PREFIX}{claim}/{item['queryId']}",
                    "variants": json.dumps([json.dumps(item)]),
                } for item in own])
            prefix = re.search(r"startsWith\(name, '([^']+)'\)", sql)
            return self._rows([
                {"name": name, "variants": json.dumps([checksum])}
                for name, checksum in self.markers.items()
                if (prefix is None or name.startswith(prefix[1]))
                and ("name = " not in sql or f"name = '{name}'" in sql)
            ])
        if "arrayMap((op, fp)" in sql:
            return self._rows([{"name": "load.sql", "migration_completed": "1" if self.journal_completed else "0",
                               "operations": json.dumps(self.journal_operations or [[0, "completed", self.fingerprint]])}])
        if "system.tables" in sql:
            source = "name = 'frozen'" in sql
            return self._rows([{"server_uuid": server, "principal": self.principal,
                                "uuid": self.source_uuid if source or "name = 'metrics'" in sql else QUERY_ID,
                                "engine": self.source_engine if source else self.engine,
                                "dependencies": self.dependencies} for server in (self.servers or [self.server])])
        if "system.parts" in sql:
            self.parts_reads += 1
            n, self.parts = self.parts, 0
            return self._rows([{"server_uuid": server, "principal": self.principal, "n": n}
                               for server in (self.servers or [self.server])])
        if sql.startswith("SELECT query_id"):
            return self._rows([{
                "query_id": QUERY_ID, "initial_query_id": QUERY_ID,
                "user": "writer", "initial_user": "writer",
            }])
        if "system.query_log" in sql:
            if self.receipt_error:
                raise RuntimeError("query log unreadable")
            servers = self.servers or [SERVER]
            return self._rows(self.receipt_rows if self.receipt_rows is not None else [
                {"server_uuid": servers[index % len(servers)], "principal": "writer", "query_id": control_id}
                for index, control_id in enumerate(self.controls)
            ])
        if sql.startswith("KILL QUERY"):
            assert query_id is not None
            assert settings == {"log_queries": 1, "log_queries_probability": 1, "log_queries_min_query_duration_ms": 0}
            self.controls.append(query_id)
            if self.kill_failure:
                raise TimeoutError("cancellation deadline expired")
            self.killed = True
            return self._rows([{"kill_status": "finished"}])
        if sql.startswith("SELECT count()"):
            return self._rows([{"n": 0 if self.killed else 1}])
        raise AssertionError(f"Unexpected control SQL: {sql}")

    @staticmethod
    def _rows(rows: list[dict[str, Any]]) -> QueryResult:
        return QueryResult(column_names=list(rows[0]) if rows else [], rows=rows)


def test_fixed_phase_budgets_accommodate_latency(monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = ControlFixture()
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    now = 0.0
    query = fixture.query_control

    def delayed(sql: str, timeout_ms: float, **kwargs: Any) -> QueryResult:
        nonlocal now
        if sql.startswith(("SELECT query_id", "SELECT count()")) or (
            sql.startswith("INSERT") and "/required" in sql
        ):
            now += 20
        return query(sql, timeout_ms, **kwargs)

    monkeypatch.setattr(time, "monotonic", lambda: now)
    monkeypatch.setattr(fixture, "query_control", delayed)
    cancel_predecessor(fixture, TARGET, plan, fixture)
    assert now == 60
    assert next(timeout for sql, timeout in fixture.calls if sql.startswith("KILL")) == 30_000
    assert next(timeout for sql, timeout in fixture.calls if sql.startswith("INSERT") and "/required" in sql) == 30_000
    assert f"{CANCELLATION_PREFIX}{CLAIM}/completed" in fixture.markers


def test_receipt_polling_never_renews_phase_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = ControlFixture()
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    now = 0.0
    reads = 0
    query = fixture.query_control

    def delayed(sql: str, timeout_ms: float, **kwargs: Any) -> QueryResult:
        nonlocal now, reads
        rows = query(sql, timeout_ms, **kwargs)
        if "system.query_log" in sql:
            now += 10
            reads += 1
            return fixture._rows([])
        return rows

    monkeypatch.setattr(time, "monotonic", lambda: now)
    monkeypatch.setattr(fixture, "query_control", delayed)
    with pytest.raises(MigrateError, match="deadline expired"):
        cancel_predecessor(fixture, TARGET, plan, fixture)
    assert reads == 3
    assert not any(sql.startswith("SELECT count()") for sql, _ in fixture.calls)
    assert not fixture.markers


@pytest.mark.parametrize("phase", ["preflight", "cancellation", "handoff"])
def test_expired_phase_cannot_advance(phase: str, monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = ControlFixture()
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    now = 0.0
    query = fixture.query_control

    def delayed(sql: str, timeout_ms: float, **kwargs: Any) -> QueryResult:
        nonlocal now
        expires = (sql.startswith("SELECT query_id") if phase == "preflight" else
                   sql.startswith("SELECT count()") if phase == "cancellation" else
                   sql.startswith("INSERT") and "/required" in sql)
        if expires:
            now += 30.001
        return query(sql, timeout_ms, **kwargs)

    monkeypatch.setattr(time, "monotonic", lambda: now)
    monkeypatch.setattr(fixture, "query_control", delayed)
    with pytest.raises(MigrateError, match="deadline expired"):
        cancel_predecessor(fixture, TARGET, plan, fixture)
    assert fixture.killed == (phase != "preflight")
    assert (f"{RECOVERY_PREFIX}{SUCCESSOR}/required" in fixture.markers) == (phase == "handoff")
    assert f"{CANCELLATION_PREFIX}{CLAIM}/completed" not in fixture.markers


def test_pending_barrier_blocks_later_owners_until_terminal_completion() -> None:
    fixture = ControlFixture()
    assert resolve_query_identity(fixture) == IDENTITY
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    mark_cancellation_pending(fixture, TARGET, plan)
    with pytest.raises(MigrateError, match="unfinished"):
        assert_cancellation_clear(fixture, TARGET)
    assert "clusterAllReplicas('declared'" in fixture.calls[-1][0]
    assert_cancellation_clear(fixture, TARGET, CLAIM)
    recovery = cancel_predecessor(fixture, TARGET, plan, fixture)
    assert fixture.killed
    assert f"{CANCELLATION_PREFIX}{CLAIM}/completed" in fixture.markers
    with pytest.raises(MigrateError, match="Recovery"):
        assert_cancellation_clear(fixture, TARGET)
    fixture.journal_completed = True
    finish_recovery(fixture, TARGET, recovery, fixture)
    assert_cancellation_clear(fixture, TARGET)
    with pytest.raises(MigrateError, match="already completed"):
        prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    kill_index = next(i for i, (sql, _) in enumerate(fixture.calls) if sql.startswith("KILL"))
    completion_index = next(
        i for i, (sql, _) in enumerate(fixture.calls)
        if sql.startswith("INSERT") and "/completed" in sql
    )
    assert completion_index > kill_index
    assert fixture.calls[completion_index][1] <= fixture.calls[kill_index][1]


@pytest.mark.parametrize("failure", ["kill_failure", "fail_completion", "held"])
def test_failure_preserves_durable_barrier(failure: str) -> None:
    fixture = ControlFixture()
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    mark_cancellation_pending(fixture, TARGET, plan)
    setattr(fixture, failure, failure != "held")
    with pytest.raises((MigrateError, RuntimeError, TimeoutError), match=r"deadline|completion|ownership"):
        cancel_predecessor(fixture, TARGET, plan, fixture)
    assert f"{CANCELLATION_PREFIX}{CLAIM}/completed" not in fixture.markers
    with pytest.raises(MigrateError, match="unfinished"):
        assert_cancellation_clear(fixture, TARGET)


@pytest.mark.parametrize("failure", [
    "async", "unsupported", "SharedMergeTree", "materialized view", "legacy", "principal", "unreadable",
    "endpoint server", "endpoint principal",
])
def test_refusal_precedes_any_kill_or_marker_write(failure: str) -> None:
    fixture = ControlFixture()
    if failure in {"async", "unsupported"}:
        fixture.kind = failure
    elif failure == "SharedMergeTree":
        fixture.engine = failure
    elif failure == "materialized view":
        fixture.dependencies = '["mv"]'
    elif failure == "legacy":
        fixture.legacy = True
    elif failure == "principal":
        fixture.principal = "another"
    elif failure == "unreadable":
        fixture.unreadable = True
    elif failure == "endpoint server":
        fixture.local_server = QUERY_ID
    elif failure == "endpoint principal":
        fixture.local_principal = "another"
    with pytest.raises((MigrateError, RuntimeError), match=r"(?i)unsupported|plain MergeTree|untracked|principal|unreadable|identity"):
        prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    assert not any(sql.startswith(("KILL", "INSERT")) for sql, _ in fixture.calls)


def test_multinode_and_malformed_claim_refuse_before_mutation() -> None:
    identity = replace(IDENTITY, server_uuids=[SERVER, QUERY_ID])
    fixture = ControlFixture(identity)
    with pytest.raises(MigrateError, match=r"one server|one declared server"):
        prepare_cancellation(fixture, TARGET, identity, CLAIM)
    with pytest.raises(MigrateError, match="UUID"):
        prepare_cancellation(fixture, TARGET, identity, "unknown")
    assert not any(sql.startswith(("KILL", "INSERT")) for sql, _ in fixture.calls)


def test_kill_requires_receipts_from_every_declared_member() -> None:
    fixture = ControlFixture()
    fixture.servers = [SERVER, QUERY_ID]
    identity = replace(IDENTITY, server_uuids=fixture.servers)
    kill_with_receipts(_Control(fixture, fixture), identity, [CLAIM])
    assert len(fixture.controls) == 2
    assert len(set(fixture.controls)) == 2
    assert all(control not in {CLAIM, QUERY_ID} for control in fixture.controls)
    receipt_sql = [sql for sql, _ in fixture.calls if "system.query_log" in sql]
    assert len(receipt_sql) == 1
    assert all("type = 'QueryFinish'" in sql and "exception_code = 0" in sql for sql in receipt_sql)
    assert not any(sql.startswith("INSERT") for sql, _ in fixture.calls)


@pytest.mark.parametrize(("field", "value"), [
    ("server_uuid", CLAIM), ("principal", "someone-else"), ("query_id", CLAIM),
])
def test_foreign_receipt_refuses_cancellation(field: str, value: str, monkeypatch: pytest.MonkeyPatch) -> None:
    control_id = "00000000-0000-4000-8000-000000000004"
    monkeypatch.setattr(migrate_cancellation, "uuid4", lambda: UUID(control_id))
    fixture = ControlFixture()
    fixture.receipt_rows = [{"server_uuid": SERVER, "principal": "writer", "query_id": control_id}]
    fixture.receipt_rows[0][field] = value
    with pytest.raises(MigrateError, match="unexpected server, principal or query id"):
        kill_with_receipts(_Control(fixture, fixture), IDENTITY, [QUERY_ID])
    assert not any(sql.startswith("INSERT") for sql, _ in fixture.calls)


def test_missing_receipt_hits_shared_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = ControlFixture()
    fixture.receipt_rows = []
    monkeypatch.setattr(migrate_cancellation, "_DEADLINE_MS", 15)
    with pytest.raises(MigrateError, match="deadline expired"):
        kill_with_receipts(_Control(fixture, fixture), IDENTITY, [QUERY_ID])
    assert fixture.controls
    assert not any(sql.startswith("INSERT") for sql, _ in fixture.calls)


def test_unreadable_receipt_does_not_supply_coverage() -> None:
    fixture = ControlFixture()
    fixture.receipt_error = True
    with pytest.raises(RuntimeError, match="query log unreadable"):
        kill_with_receipts(_Control(fixture, fixture), IDENTITY, [QUERY_ID])
    assert len(fixture.controls) == 1
    assert not any(sql.startswith("INSERT") for sql, _ in fixture.calls)


def test_lost_required_ack_redirects_to_resumable_zero_own_intent_context() -> None:
    fixture = ControlFixture()
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    mark_cancellation_pending(fixture, TARGET, plan)
    fixture.fail_required = "after"
    with pytest.raises(RuntimeError, match="ACK lost"):
        cancel_predecessor(fixture, TARGET, plan, fixture)
    assert f"{CANCELLATION_PREFIX}{CLAIM}/completed" not in fixture.markers
    with pytest.raises(MigrateError, match=SUCCESSOR):
        assert_cancellation_clear(fixture, TARGET)
    with pytest.raises(MigrateError, match=SUCCESSOR):
        prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    fixture.fail_required = ""
    inherited = prepare_cancellation(fixture, TARGET, IDENTITY, SUCCESSOR)
    assert inherited.inherited
    assert inherited.obligations == plan.obligations
    assert_cancellation_clear(fixture, TARGET, SUCCESSOR)
    mark_cancellation_pending(fixture, TARGET, inherited)
    old_kills = len(fixture.controls)
    fixture.claim_id = NEXT
    context = cancel_predecessor(fixture, TARGET, inherited, fixture)
    assert len(fixture.controls) == old_kills
    assert context.parents == sorted([CLAIM, SUCCESSOR])
    with pytest.raises(MigrateError, match=NEXT):
        assert_cancellation_clear(fixture, TARGET)
    fixture.journal_completed = True
    finish_recovery(fixture, TARGET, context, fixture)
    assert_cancellation_clear(fixture, TARGET)


def test_absent_required_marker_retains_original_resumable_barrier() -> None:
    fixture = ControlFixture()
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    mark_cancellation_pending(fixture, TARGET, plan)
    fixture.fail_required = "before"
    with pytest.raises(RuntimeError, match="required absent"):
        cancel_predecessor(fixture, TARGET, plan, fixture)
    assert f"{RECOVERY_PREFIX}{SUCCESSOR}/required" not in fixture.markers
    with pytest.raises(MigrateError, match=CLAIM):
        assert_cancellation_clear(fixture, TARGET)
    assert prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM).claim == CLAIM


def test_transfer_survives_parent_completion_ack_loss() -> None:
    fixture = ControlFixture()
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    mark_cancellation_pending(fixture, TARGET, plan)
    cancel_predecessor(fixture, TARGET, plan, fixture)
    inherited = prepare_cancellation(fixture, TARGET, IDENTITY, SUCCESSOR)
    mark_cancellation_pending(fixture, TARGET, inherited)
    fixture.claim_id = NEXT
    fixture.fail_recovery_completion = "after"
    with pytest.raises(RuntimeError, match="ACK lost"):
        cancel_predecessor(fixture, TARGET, inherited, fixture)
    with pytest.raises(MigrateError, match=NEXT):
        assert_cancellation_clear(fixture, TARGET)
    with pytest.raises(MigrateError, match=NEXT):
        prepare_cancellation(fixture, TARGET, IDENTITY, SUCCESSOR)
    assert prepare_cancellation(fixture, TARGET, IDENTITY, NEXT).inherited


def test_linked_empty_reservations_can_resume_before_initial_or_inherited_pending_write() -> None:
    fixture = ControlFixture()
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    assert_cancellation_unfinished(fixture, TARGET, plan, [{
        "claim": NEXT, "holder": json.dumps({"recoveryOf": CLAIM, "queries": IDENTITY.to_payload()}),
    }])
    with pytest.raises(MigrateError, match="linked"):
        assert_cancellation_unfinished(fixture, TARGET, plan, [{
            "claim": NEXT,
            "holder": json.dumps({"recoveryOf": SUCCESSOR, "queries": IDENTITY.to_payload()}),
        }])
    mark_cancellation_pending(fixture, TARGET, plan)
    cancel_predecessor(fixture, TARGET, plan, fixture)
    inherited = prepare_cancellation(fixture, TARGET, IDENTITY, SUCCESSOR)
    assert_cancellation_unfinished(fixture, TARGET, inherited, [{
        "claim": NEXT,
        "holder": json.dumps({"recoveryOf": SUCCESSOR, "queries": IDENTITY.to_payload()}),
    }])


def test_full_selected_plan_attests_both_targets_and_refuses_unsupported_tail_before_mutation() -> None:
    fixture = ControlFixture()
    initial = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    contexts = [
        QueryContext("load.sql", 0, "INSERT INTO app.events SELECT 1", "TRUNCATE TABLE app.events"),
        QueryContext("load.sql", 1, "INSERT INTO app.metrics SELECT 2", "TRUNCATE TABLE app.metrics"),
    ]
    full = expand_recovery_plan(fixture, TARGET, initial, contexts)
    assert len(full.obligations) == 2
    assert [target.name for target in full.targets] == ["events", "metrics"]
    with pytest.raises(MigrateError, match="throughout"):
        expand_recovery_plan(fixture, TARGET, initial, [
            *contexts, QueryContext("load.sql", 2, "ALTER TABLE app.events ADD COLUMN x UInt8", None),
        ])
    assert not any(sql.startswith(("KILL", "INSERT")) for sql, _ in fixture.calls)
    with pytest.raises(MigrateError, match="include it in apply"):
        expand_recovery_plan(fixture, TARGET, initial, [])
    fixture.journal_completed = True
    assert expand_recovery_plan(fixture, TARGET, initial, []).obligations == initial.obligations


def test_shared_recovery_requires_capability_and_settled_parts_on_each_server() -> None:
    identity = replace(IDENTITY, server_uuids=[SERVER, "00000000-0000-4000-8000-000000000004"])
    fixture = ControlFixture(identity)
    fixture.engine = fixture.recorded_engine = "SharedMergeTree"
    plan = prepare_cancellation(fixture, TARGET, identity, CLAIM)
    mark_cancellation_pending(fixture, TARGET, plan)
    cancel_predecessor(fixture, TARGET, plan, fixture)
    fixture.parts = 8
    settle_compensation(fixture, plan, plan.targets[0], fixture)
    assert fixture.parts_reads == 2
    assert "view(SELECT" in next(sql for sql, _ in fixture.calls if "system.parts" in sql)
    with pytest.raises(MigrateError, match="Recovery"):
        assert_cancellation_clear(fixture, TARGET)
    fixture.capability = 0
    with pytest.raises(MigrateError, match="protocol 1"):
        settle_compensation(fixture, plan, plan.targets[0], fixture)


@pytest.mark.parametrize("fault", ["disabled", "mixed", "unknown"])
def test_shared_preflight_refuses_missing_backend_guarantees_before_any_kill(fault: str) -> None:
    identity = replace(IDENTITY, server_uuids=[SERVER, "00000000-0000-4000-8000-000000000004"])
    fixture = ControlFixture(identity)
    fixture.engine = fixture.recorded_engine = "SharedMergeTree"
    if fault == "disabled":
        fixture.capability = 0
    elif fault == "mixed":
        fixture.capability_overrides = [1, 0]
    else:
        fixture.capability_error = True
    with pytest.raises((MigrateError, RuntimeError), match=r"protocol 1|UNKNOWN_FUNCTION"):
        prepare_cancellation(fixture, TARGET, identity, CLAIM)
    assert not any(sql.startswith(("KILL", "INSERT")) for sql, _ in fixture.calls)


def test_complete_plan_refuses_repeated_targets_and_any_mutated_frozen_source() -> None:
    fixture = ControlFixture()
    initial = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    contexts = [
        QueryContext("load.sql", 0, "INSERT INTO app.events SELECT 1", "TRUNCATE TABLE app.events"),
        QueryContext("load.sql", 1, "INSERT INTO app.events SELECT 2", "TRUNCATE TABLE app.events"),
    ]
    with pytest.raises(MigrateError, match="compensation target"):
        expand_recovery_plan(fixture, TARGET, initial, contexts)
    chain = [
        QueryContext("load.sql", 0, "INSERT INTO app.events SELECT id FROM app.frozen", "TRUNCATE TABLE app.events"),
        QueryContext("load.sql", 1, "INSERT INTO app.frozen SELECT 2", "TRUNCATE TABLE app.frozen"),
    ]
    with pytest.raises(MigrateError, match="frozen source"):
        expand_recovery_plan(fixture, TARGET, replace(initial, obligations=[]), chain)
    assert not any(sql.startswith(("KILL", "INSERT")) for sql, _ in fixture.calls)


@pytest.mark.parametrize("sql", [
    "INSERT INTO app._chkit_migrations SELECT 1", "INSERT INTO app.events SELECT id FROM app._chkit_migrations",
])
def test_journal_is_never_an_eligible_recovery_data_table(sql: str) -> None:
    fixture = ControlFixture()
    initial = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    before = "TRUNCATE TABLE app._chkit_migrations" if "migrations SELECT 1" in sql else "TRUNCATE TABLE app.events"
    with pytest.raises(MigrateError, match="journal"):
        expand_recovery_plan(fixture, TARGET, replace(initial, obligations=[]), [QueryContext("load.sql", 0, sql, before)])
    assert not any(query.startswith(("KILL", "INSERT")) for query, _ in fixture.calls)


@pytest.mark.parametrize("replicas", [2, 3])
def test_round_robin_routes_every_request_without_pinning_kills_to_one_node(replicas: int) -> None:
    identity = replace(IDENTITY, server_uuids=[SERVER, QUERY_ID, SOURCE][:replicas])
    requests = 0
    waits = 0
    receipts: list[dict[str, Any]] = []
    killed: set[str] = set()

    class RoundRobinControl:
        def remaining(self) -> float:
            nonlocal waits
            waits += 1
            if waits > 3:
                raise RuntimeError("bounded regression deadline")
            return 1

        def query(self, sql: str, *, query_id: str | None = None, settings: Any = None) -> list[dict[str, Any]]:
            nonlocal requests
            server = identity.server_uuids[requests % len(identity.server_uuids)]
            requests += 1
            if "system.one" in sql:
                return [{"server_uuid": member, "principal": "writer"} for member in identity.server_uuids]
            if sql == "SELECT toString(serverUUID()) AS server_uuid, currentUser() AS principal":
                return [{"server_uuid": server, "principal": "writer"}]
            if sql.startswith("KILL QUERY"):
                killed.add(server)
                receipts.append({"server_uuid": server, "principal": "writer", "query_id": query_id})
                return []
            if "system.query_log" in sql:
                return list(receipts)
            raise AssertionError(sql)

    kill_with_receipts(RoundRobinControl(), identity, [CLAIM])  # type: ignore[arg-type]
    assert killed == set(identity.server_uuids)
    assert len({row["query_id"] for row in receipts}) == len(receipts)
