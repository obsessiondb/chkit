"""Fault injection for durable cancellation and refusal before replacement work."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from typing import Any

import pytest

from chkit.cli.commands.migrate_cancellation import (
    CANCELLATION_PREFIX,
    RECOVERY_PREFIX,
    REPLACE_PREFIX,
    assert_cancellation_clear,
    assert_cancellation_unfinished,
    cancel_predecessor,
    expand_recovery_plan,
    finish_recovery,
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
REPLACED = "00000000-0000-4000-8000-000000000009"
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
        self.target_uuid = QUERY_ID
        self.replaced_servers: list[str] = []
        self.replace_after_reads = -1
        self.table_reads = 0
        self.compensated = False
        self.untracked = False
        self.database_engine = "Atomic"
        self.grants: list[dict[str, Any]] = [
            {"access_type": "ALL", "database": None, "table": None, "is_partial_revoke": 0},
        ]
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
        self.kills = 0
        self.servers: list[str] | None = identity.server_uuids if len(identity.server_uuids) > 1 else None
        self.fingerprint = statement_fingerprint("INSERT INTO app.events SELECT 1")

    def execute_tracked(self, *_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("No replacement SQL belongs in cancellation preflight")

    def assert_held(self) -> None:
        if not self.held:
            raise RuntimeError("lost ownership")

    def query_control(self, sql: str, timeout_ms: float, **_options: Any) -> QueryResult:  # noqa: PLR0911, PLR0912
        """Dispatch the scripted SQL protocol, including forced failure branches."""
        self.calls.append((sql, timeout_ms))
        if self.unreadable:
            raise RuntimeError("replica unreadable")
        if "FROM system.clusters" in sql:
            return self._rows([{"host": "host", "port": "9000", "shard": "1", "replica": "1"}])
        if "serverUUID()" in sql and "clusterAllReplicas" not in sql and sql.startswith("SELECT"):
            return self._rows([{"server_uuid": self.local_server, "principal": self.local_principal}])
        if "system.grants" in sql:
            return self._rows(self.grants)
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
                compensation = {
                    **intent, "queryId": NEXT, "phase": "compensation", "kind": "replace",
                    "fingerprint": statement_fingerprint("CREATE OR REPLACE TABLE app.events AS app.events"),
                }
                own = ([intent, compensation] if self.compensated else [intent]) if claim == CLAIM else self.intents.get(claim, [])
                untracked = [{"name": f"{QUERY_INTENT_PREFIX}{claim}/untracked",
                              "variants": json.dumps([json.dumps({"protocol": 1, "claim": claim})])}]
                return self._rows([{
                    "name": f"{QUERY_INTENT_PREFIX}{claim}/{item['queryId']}",
                    "variants": json.dumps([json.dumps(item)]),
                } for item in own] + (untracked if self.untracked and claim == CLAIM else []))
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
            events = not source and "name = 'metrics'" not in sql
            if events:
                self.table_reads += 1
                if self.table_reads == self.replace_after_reads:
                    self.target_uuid = REPLACED
            return self._rows([{"server_uuid": server, "principal": self.principal,
                                "uuid": self.source_uuid if not events else REPLACED if server in self.replaced_servers else self.target_uuid,
                                "engine": self.source_engine if source else self.engine,
                                "dependencies": self.dependencies, "database_engine": self.database_engine}
                               for server in (self.servers or [self.server])])
        if sql.startswith("SELECT query_id"):
            return self._rows([{
                "query_id": QUERY_ID, "initial_query_id": QUERY_ID,
                "user": "writer", "initial_user": "writer",
            }])
        if sql.startswith("KILL QUERY"):
            self.kills += 1
            if self.kill_failure:
                raise RuntimeError("KILL denied")
            self.killed = True
            return self._rows([{"kill_status": "finished"}])
        raise AssertionError(f"Unexpected control SQL: {sql}")

    @staticmethod
    def _rows(rows: list[dict[str, Any]]) -> QueryResult:
        return QueryResult(column_names=list(rows[0]) if rows else [], rows=rows)


def test_failed_kill_does_not_block_recovery_the_replace_is_the_gate() -> None:
    fixture = ControlFixture()
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    fixture.kill_failure = True
    mark_cancellation_pending(fixture, TARGET, plan)
    cancel_predecessor(fixture, TARGET, plan, fixture)
    kills = [sql for sql, _ in fixture.calls if sql.startswith("KILL")]
    assert len(kills) == 1
    assert kills[0].endswith("ASYNC")
    assert f"{CANCELLATION_PREFIX}{CLAIM}/completed" in fixture.markers


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


@pytest.mark.parametrize("failure", ["fail_completion", "held"])
def test_failure_preserves_durable_barrier(failure: str) -> None:
    fixture = ControlFixture()
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    mark_cancellation_pending(fixture, TARGET, plan)
    setattr(fixture, failure, failure != "held")
    with pytest.raises((MigrateError, RuntimeError), match=r"completion|ownership"):
        cancel_predecessor(fixture, TARGET, plan, fixture)
    assert f"{CANCELLATION_PREFIX}{CLAIM}/completed" not in fixture.markers
    with pytest.raises(MigrateError, match="unfinished"):
        assert_cancellation_clear(fixture, TARGET)


@pytest.mark.parametrize("failure", [
    "async", "unsupported", "SharedMergeTree", "materialized view", "legacy", "principal", "unreadable",
    "endpoint server", "endpoint principal", "Ordinary database", "no DROP grant", "revoked CREATE",
])
def test_refusal_precedes_any_kill_or_marker_write(failure: str) -> None:
    fixture = ControlFixture()
    if failure == "Ordinary database":
        fixture.database_engine = "Ordinary"
    elif failure == "no DROP grant":
        fixture.grants = [{"access_type": "CREATE TABLE", "database": "app", "table": None, "is_partial_revoke": 0}]
    elif failure == "revoked CREATE":
        fixture.grants.append({"access_type": "CREATE", "database": "app", "table": "events", "is_partial_revoke": 1})
    elif failure in {"async", "unsupported"}:
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
    with pytest.raises((MigrateError, RuntimeError), match=r"(?i)unsupported|plain MergeTree|untracked|principal|unreadable|identity|Atomic|DROP TABLE"):
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


def test_untracked_predecessor_cannot_be_cancelled() -> None:
    fixture = ControlFixture()
    fixture.untracked = True
    with pytest.raises(MigrateError, match="could not track"):
        prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    assert not any(sql.startswith(("KILL", "INSERT")) for sql, _ in fixture.calls)


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
    old_kills = fixture.kills
    fixture.claim_id = NEXT
    context = cancel_predecessor(fixture, TARGET, inherited, fixture)
    assert fixture.kills == old_kills
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
        QueryContext("load.sql", 0, "INSERT INTO app.events SELECT 1", "CREATE OR REPLACE TABLE app.events AS app.events"),
        QueryContext("load.sql", 1, "INSERT INTO app.metrics SELECT 2", "CREATE OR REPLACE TABLE app.metrics AS app.metrics"),
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


def test_settle_waits_for_every_replica_then_records_the_new_uuid() -> None:
    identity = replace(IDENTITY, server_uuids=[SERVER, "00000000-0000-4000-8000-000000000004"])
    fixture = ControlFixture(identity)
    fixture.engine = fixture.recorded_engine = "SharedMergeTree"
    plan = prepare_cancellation(fixture, TARGET, identity, CLAIM)
    assert plan.targets[0].uuid == QUERY_ID
    fixture.replaced_servers = [SERVER]
    fixture.replace_after_reads = fixture.table_reads + 2
    replaced = settle_compensation(fixture, TARGET, plan, plan.targets[0], fixture)
    assert (replaced.uuid, replaced.engine) == (REPLACED, "SharedMergeTree")
    assert json.loads(fixture.markers[f"{REPLACE_PREFIX}{QUERY_ID}"])["uuid"] == REPLACED
    # Later reads resolve the recorded UUID through the marker.
    assert prepare_cancellation(fixture, TARGET, identity, CLAIM).targets[0].uuid == REPLACED


def test_settle_refuses_a_replaced_table_with_new_dependencies() -> None:
    fixture = ControlFixture()
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    fixture.target_uuid = REPLACED
    fixture.dependencies = '["mv"]'
    with pytest.raises(MigrateError, match="dependencies"):
        settle_compensation(fixture, TARGET, plan, plan.targets[0], fixture)
    assert not fixture.markers


def test_replace_without_marker_is_adopted_only_when_recorded() -> None:
    fixture = ControlFixture()
    fixture.target_uuid = REPLACED
    with pytest.raises(MigrateError, match="identity changed"):
        prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    fixture.compensated = True
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    assert plan.targets[0].uuid == REPLACED
    mark_cancellation_pending(fixture, TARGET, plan)
    recovery = cancel_predecessor(fixture, TARGET, plan, fixture)
    assert f"{REPLACE_PREFIX}{QUERY_ID}" in fixture.markers
    assert recovery.obligations[0].target.uuid == REPLACED


def test_one_best_effort_local_kill_per_declared_member() -> None:
    identity = replace(IDENTITY, server_uuids=[SERVER, "00000000-0000-4000-8000-000000000004"])
    fixture = ControlFixture(identity)
    fixture.engine = fixture.recorded_engine = "SharedMergeTree"
    plan = prepare_cancellation(fixture, TARGET, identity, CLAIM)
    cancel_predecessor(fixture, TARGET, plan, fixture)
    kills = [sql for sql, _ in fixture.calls if sql.startswith("KILL")]
    assert len(kills) == 2
    assert "ON CLUSTER" not in kills[0]
    assert "user = 'writer'" in kills[0]


def test_complete_plan_refuses_repeated_targets_and_any_mutated_frozen_source() -> None:
    fixture = ControlFixture()
    initial = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    contexts = [
        QueryContext("load.sql", 0, "INSERT INTO app.events SELECT 1", "CREATE OR REPLACE TABLE app.events AS app.events"),
        QueryContext("load.sql", 1, "INSERT INTO app.events SELECT 2", "CREATE OR REPLACE TABLE app.events AS app.events"),
    ]
    with pytest.raises(MigrateError, match="compensation target"):
        expand_recovery_plan(fixture, TARGET, initial, contexts)
    chain = [
        QueryContext("load.sql", 0, "INSERT INTO app.events SELECT id FROM app.frozen", "CREATE OR REPLACE TABLE app.events AS app.events"),
        QueryContext("load.sql", 1, "INSERT INTO app.frozen SELECT 2", "CREATE OR REPLACE TABLE app.frozen AS app.frozen"),
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
    before = "CREATE OR REPLACE TABLE app._chkit_migrations AS app._chkit_migrations" if "migrations SELECT 1" in sql else "CREATE OR REPLACE TABLE app.events AS app.events"
    with pytest.raises(MigrateError, match="journal"):
        expand_recovery_plan(fixture, TARGET, replace(initial, obligations=[]), [QueryContext("load.sql", 0, sql, before)])
    assert not any(query.startswith(("KILL", "INSERT")) for query, _ in fixture.calls)
