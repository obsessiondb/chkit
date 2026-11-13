"""Fault injection for durable cancellation and refusal before replacement work."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from typing import Any

import pytest

from chkit.cli.commands.migrate_cancellation import (
    CANCELLATION_PREFIX,
    assert_cancellation_clear,
    cancel_predecessor,
    mark_cancellation_pending,
    prepare_cancellation,
    resolve_query_identity,
)
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.commands.migrate_lock import LockTarget
from chkit.cli.commands.migrate_query_intents import QUERY_INTENT_PREFIX, QueryIdentity
from chkit.clickhouse.client import QueryResult
from chkit.core.sql_fingerprint import statement_fingerprint

CLAIM = "00000000-0000-4000-8000-000000000001"
QUERY_ID = "00000000-0000-4000-8000-000000000002"
SERVER = "00000000-0000-4000-8000-000000000003"
IDENTITY = QueryIdentity(1, "writer", [SERVER], "declared")
TARGET = LockTarget("app", "_chkit_migrations", None)


class ControlFixture:
    query_control_cluster = "declared"

    def __init__(self) -> None:
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
        self.fingerprint = statement_fingerprint("INSERT INTO app.events SELECT 1")

    def execute_tracked(self, *_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("No replacement SQL belongs in cancellation preflight")

    def assert_held(self) -> None:
        if not self.held:
            raise RuntimeError("lost ownership")

    def query_control(self, sql: str, timeout_ms: float) -> QueryResult:  # noqa: PLR0911, PLR0912
        """Dispatch the scripted SQL protocol, including forced failure branches."""
        self.calls.append((sql, timeout_ms))
        if self.unreadable:
            raise RuntimeError("replica unreadable")
        if "FROM system.clusters" in sql:
            return self._rows([{"host": "host", "port": "9000", "shard": "1", "replica": "1"}])
        if "serverUUID()" in sql and "clusterAllReplicas" not in sql and sql.startswith("SELECT"):
            return self._rows([{"server_uuid": self.local_server, "principal": self.local_principal}])
        if "system.one" in sql:
            return self._rows([{"server_uuid": self.server, "principal": self.principal}])
        if "argMax(tuple(applied_at" in sql:
            return self._rows([{
                "name": f"__chkit_migrate_lock__/{CLAIM}",
                "holder": json.dumps({} if self.legacy else {"queries": IDENTITY.to_payload()}),
            }])
        if sql.startswith("INSERT INTO"):
            match = re.search(r"SELECT '([^']+)', now64\(3\), '((?:[^'\\]|\\.)*)'", sql)
            assert match is not None, "unexpected marker INSERT"
            if self.fail_completion and match[1].endswith("/completed"):
                raise RuntimeError("completion unavailable")
            self.markers[match[1]] = re.sub(r"\\(.)", r"\1", match[2])
            return self._rows([])
        if "groupUniqArray(checksum)" in sql:
            if QUERY_INTENT_PREFIX in sql:
                intent = {
                    **IDENTITY.to_payload(), "claim": CLAIM, "queryId": QUERY_ID,
                    "migration": "load.sql", "statementIndex": 0, "phase": "forward",
                    "kind": self.kind, "fingerprint": self.fingerprint,
                    "target": {"database": "app", "name": "events"},
                }
                return self._rows([{
                    "name": f"{QUERY_INTENT_PREFIX}{CLAIM}/{QUERY_ID}",
                    "variants": json.dumps([json.dumps(intent)]),
                }])
            return self._rows([
                {"name": name, "variants": json.dumps([checksum])}
                for name, checksum in self.markers.items()
                if "name = " not in sql or f"name = '{name}'" in sql
            ])
        if "system.tables" in sql:
            return self._rows([{"engine": self.engine, "dependencies": self.dependencies}])
        if sql.startswith("SELECT query_id"):
            return self._rows([{
                "query_id": QUERY_ID, "initial_query_id": QUERY_ID,
                "user": "writer", "initial_user": "writer",
            }])
        if sql.startswith("KILL QUERY"):
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


def test_pending_barrier_blocks_later_owners_until_terminal_completion() -> None:
    fixture = ControlFixture()
    assert resolve_query_identity(fixture) == IDENTITY
    plan = prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    mark_cancellation_pending(fixture, TARGET, plan)
    with pytest.raises(MigrateError, match="unfinished"):
        assert_cancellation_clear(fixture, TARGET)
    assert "clusterAllReplicas('declared'" in fixture.calls[-1][0]
    assert_cancellation_clear(fixture, TARGET, CLAIM)
    cancel_predecessor(fixture, TARGET, plan, fixture)
    assert fixture.killed
    assert f"{CANCELLATION_PREFIX}{CLAIM}/completed" in fixture.markers
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
    with pytest.raises((MigrateError, RuntimeError), match=r"(?i)unsupported|plain MergeTree|untracked|principal|unreadable"):
        prepare_cancellation(fixture, TARGET, IDENTITY, CLAIM)
    assert not any(sql.startswith(("KILL", "INSERT")) for sql, _ in fixture.calls)


def test_multinode_and_malformed_claim_refuse_before_any_request() -> None:
    fixture = ControlFixture()
    with pytest.raises(MigrateError, match="one declared server"):
        prepare_cancellation(fixture, TARGET, replace(IDENTITY, server_uuids=[SERVER, QUERY_ID]), CLAIM)
    with pytest.raises(MigrateError, match="UUID"):
        prepare_cancellation(fixture, TARGET, IDENTITY, "unknown")
    assert fixture.calls == []
