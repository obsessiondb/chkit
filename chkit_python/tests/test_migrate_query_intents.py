"""Executable-SQL classification and durable migration query intent admission."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

import pytest

from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.commands.migrate_lock import LockTarget
from chkit.cli.commands.migrate_query_intents import (
    QueryContext,
    QueryIdentity,
    QueryRecovery,
    QueryTarget,
    QueryTracker,
    classify_query_intent,
)
from chkit.clickhouse.client import QueryResult
from chkit.core.sql_fingerprint import statement_fingerprint

IDENTITY = QueryIdentity(1, "writer", ["00000000-0000-4000-8000-000000000001"])
CONTEXT = QueryContext(
    "load.sql", 0, "INSERT INTO app.events SELECT 1", "TRUNCATE TABLE app.events",
)
TARGET = LockTarget("app", "_chkit_migrations", None)


def test_insert_body_cannot_hide_a_different_sql_target_after_table_keyword() -> None:
    assert classify_query_intent(
        "INSERT INTO TABLE app.events SELECT 1", "forward", "TRUNCATE TABLE app.TABLE", "app",
    ).kind == "unsupported"
    assert classify_query_intent(
        "INSERT INTO app.events (id) SELECT 1", "forward", CONTEXT.before_retry,
    ).kind == "insert"


class FakeLock:
    claim_id = "claim"
    held = True

    def assert_held(self) -> None:
        if not self.held:
            raise RuntimeError("lost ownership")


class IntentClient:
    def __init__(self, lock: FakeLock, failure: str) -> None:
        self.lock = lock
        self.failure = failure
        self.events: list[str] = []
        self.checksum = ""

    def execute(self, sql: str) -> None:
        self.events.append("intent")
        match = re.search(r", '((?:[^'\\]|\\.)*)', '.*', false, \[\] SETTINGS", sql)
        assert match is not None
        self.checksum = re.sub(r"\\(.)", r"\1", match[1])
        if self.failure == "intent":
            raise RuntimeError("intent failed")

    def query(self, _sql: str) -> QueryResult:
        self.events.append("read-back")
        if self.failure == "ownership":
            self.lock.held = False
        rows = [] if self.failure == "read-back" else [{"checksum": self.checksum}]
        return QueryResult(column_names=["checksum"], rows=rows)

    def execute_tracked(
        self, _sql: str, check: Any, before: Any, _settings: Any,
    ) -> None:
        check()
        assert str(uuid.UUID(before()))
        check()
        self.events.append("user SQL")


@pytest.mark.parametrize("failure", ["none", "intent", "ownership", "read-back"])
def test_intent_is_acknowledged_before_user_sql(failure: str) -> None:
    lock = FakeLock()
    client = IntentClient(lock, failure)
    tracker = QueryTracker(client, TARGET, IDENTITY, lock)  # type: ignore[arg-type]
    if failure == "none":
        tracker.command(CONTEXT, "forward", CONTEXT.forward_sql)
        assert client.events == ["intent", "read-back", "user SQL"]
    else:
        with pytest.raises(RuntimeError if failure != "read-back" else Exception):
            tracker.command(CONTEXT, "forward", CONTEXT.forward_sql)
        assert "user SQL" not in client.events
    assert "INSERT INTO" not in client.checksum
    assert "TRUNCATE TABLE" not in client.checksum
    payload = json.loads(client.checksum)
    assert payload["serverUUIDs"] == IDENTITY.server_uuids
    assert payload["claim"] == "claim"
    assert payload["kind"] == "insert"


@pytest.mark.parametrize("sql", [
    "INSERT INTO app.events SELECT 1 PARALLEL WITH INSERT INTO other.x SELECT 1",
    "INSERT INTO FUNCTION remote('host', app.events) SELECT 1",
    "INSERT INTO app.events SELECT 1 SETTINGS async_insert=1",
    "INSERT INTO app.events SELECT 1 SETTINGS `async_insert`=1",
    "INSERT INTO app.events SELECT * FROM remote('host', app.events)",
    "INSERT INTO app.events SELECT * FROM `remoteSecure`('host', app.events)",
    "INSERT INTO app.events SELECT * FROM s3Cluster('cluster', 'url')",
    "INSERT INTO app.events SELECT * FROM numbers(1), app.distributed",
    "INSERT INTO app.events SELECT number IN app.distributed FROM numbers(1)",
    "INSERT INTO app.events SELECT number GLOBAL IN app.distributed FROM numbers(1)",
    "INSERT INTO app.events SELECT customFunction(1)",
    "ALTER TABLE app.events DELETE WHERE 1",
    "INSERT INTO app.events SELECT 1; INSERT INTO other.x SELECT 1",
])
def test_only_local_synchronous_compensatable_inserts_are_cancellable(sql: str) -> None:
    assert classify_query_intent(sql, "forward", CONTEXT.before_retry).kind == "unsupported"


def test_quoted_targets_and_comments_use_the_lexer() -> None:
    classification = classify_query_intent(
        "/* INSERT INTO wrong.x */ INSERT INTO `app`.`events` SELECT 1",
        "forward", CONTEXT.before_retry,
    )
    assert classification.kind == "insert"
    assert classification.target is not None
    assert classification.target.to_payload() == {"database": "app", "name": "events"}
    assert classify_query_intent(
        CONTEXT.forward_sql, "forward", "TRUNCATE TABLE other.events",
    ).kind == "unsupported"


@pytest.mark.parametrize("settings", [
    {"async_insert": 1}, {"query_id": "user-id"}, {"wait_for_async_insert": 0},
    {"cluster_for_parallel_replicas": "other"}, {"max_parallel_replicas": 2},
])
def test_unsupported_settings_are_recorded_for_refusal(settings: dict[str, Any]) -> None:
    lock = FakeLock()
    client = IntentClient(lock, "none")
    tracker = QueryTracker(client, TARGET, IDENTITY, lock)  # type: ignore[arg-type]
    tracker.command(CONTEXT, "forward", CONTEXT.forward_sql, settings)
    assert json.loads(client.checksum)["kind"] == "unsupported"


def test_async_intent_keeps_its_existing_id_and_is_noncancellable() -> None:
    lock = FakeLock()
    client = IntentClient(lock, "none")
    tracker = QueryTracker(client, TARGET, IDENTITY, lock)  # type: ignore[arg-type]
    tracker.record_async(CONTEXT, "existing-first-attempt")
    assert json.loads(client.checksum)["queryId"] == "existing-first-attempt"
    assert json.loads(client.checksum)["kind"] == "async"
    assert client.events == ["intent", "read-back"]


def test_one_named_source_is_classified_without_hidden_secondary_sources() -> None:
    result = classify_query_intent(
        "INSERT INTO app.events SELECT id, toString(id) FROM app.frozen WHERE id > 0",
        "forward", CONTEXT.before_retry,
    )
    assert result.kind == "insert"
    assert result.source is not None
    assert result.source.to_payload() == {"database": "app", "name": "frozen"}
    for sql in [
        "INSERT INTO app.events SELECT id FROM app.events",
        "INSERT INTO app.events SELECT id FROM app.frozen, other.distributed",
        "INSERT INTO app.events SELECT id FROM app.frozen JOIN other.x USING id",
        "INSERT INTO app.events SELECT (SELECT id FROM app.frozen)",
        "INSERT INTO app.events SELECT id FROM app.frozen WHERE id IN other.view",
        "INSERT INTO app.events SELECT id FROM app.frozen UNION ALL SELECT id FROM app.other",
    ]:
        assert classify_query_intent(sql, "forward", CONTEXT.before_retry).kind == "unsupported"


@pytest.mark.parametrize("fault", [
    "none", "denied", "distributed", "missing member", "ownership", "compensation source",
])
def test_named_source_metadata_is_acknowledged_before_sql(fault: str) -> None:
    lock = FakeLock()

    class MetadataClient(IntentClient):
        def query_control(self, sql: str, _timeout_ms: float) -> QueryResult:
            self.events.append("metadata")
            assert "view(SELECT" in sql
            if fault == "denied":
                raise RuntimeError("ACCESS_DENIED")
            if fault == "ownership":
                self.lock.held = False
            source = "name = 'frozen'" in sql
            rows = [] if fault == "missing member" else [{
                "server_uuid": IDENTITY.server_uuids[0], "principal": "writer",
                "uuid": "00000000-0000-4000-8000-000000000003" if source else "00000000-0000-4000-8000-000000000002",
                "engine": "Distributed" if fault == "distributed" and source else "MergeTree",
                "dependencies": "[]",
            }]
            return QueryResult(column_names=[], rows=rows)

    client = MetadataClient(lock, "none")
    identity = QueryIdentity(1, "writer", IDENTITY.server_uuids, "declared")
    tracker = QueryTracker(client, TARGET, identity, lock)  # type: ignore[arg-type]
    sql = "INSERT INTO app.events SELECT id FROM app.frozen"
    context = QueryContext("load.sql", 0, sql, CONTEXT.before_retry)
    if fault == "ownership":
        with pytest.raises(RuntimeError, match="lost ownership"):
            tracker.command(context, "compensation" if fault == "compensation source" else "forward",
                        "TRUNCATE TABLE app.events" if fault == "compensation source" else sql)
        assert "user SQL" not in client.events
    else:
        tracker.command(context, "compensation" if fault == "compensation source" else "forward",
                        "TRUNCATE TABLE app.events" if fault == "compensation source" else sql)
        intent = json.loads(client.checksum)
        assert intent["kind"] == ("truncate" if fault == "compensation source"
                                  else "insert" if fault == "none" else "unsupported")
        assert client.events[-1] == "user SQL"
        assert intent["forwardFingerprint"] == statement_fingerprint(sql)
        if fault == "compensation source":
            assert intent["fingerprint"] == statement_fingerprint("TRUNCATE TABLE app.events")
        if fault in {"none", "compensation source"}:
            assert intent["source"]["uuid"] == "00000000-0000-4000-8000-000000000003"
            assert intent["target"]["uuid"] == "00000000-0000-4000-8000-000000000002"
            assert client.events == ["metadata", "metadata", "intent", "read-back", "user SQL"]


@pytest.mark.parametrize("fault", [
    "none", "unsupported SQL", "changed UUID", "metadata denied", "settlement failure", "lost after SQL", "source changed",
])
def test_explicit_recovery_admission_and_settlement_precede_forward_sql(fault: str) -> None:
    lock = FakeLock()
    table = QueryTarget("app", "events", "00000000-0000-4000-8000-000000000002", "SharedMergeTree")

    class RecoveryClient(IntentClient):
        def query_control(self, sql: str, _timeout_ms: float) -> QueryResult:
            self.events.append("metadata")
            if fault == "metadata denied":
                raise RuntimeError("ACCESS_DENIED")
            return QueryResult(column_names=[], rows=[{
                "server_uuid": IDENTITY.server_uuids[0], "principal": "writer",
                "uuid": ("00000000-0000-4000-8000-000000000004" if "name = 'frozen'" in sql
                         else IDENTITY.server_uuids[0] if fault == "changed UUID" else table.uuid),
                "engine": "SharedMergeTree", "dependencies": "[]",
            }])

        def execute_tracked(self, sql: str, check: Any, before: Any, settings: Any) -> None:
            check()
            before()
            check()
            compensation = sql.startswith("TRUNCATE")
            if compensation:
                assert settings["shared_merge_tree_require_truncate_fence"] == 1
            self.events.append("compensation" if compensation else "forward")
            if fault == "lost after SQL":
                self.lock.held = False

    client = RecoveryClient(lock, "none")

    def settled(actual: QueryTarget) -> None:
        assert actual == table
        client.events.append("settled")
        if fault == "settlement failure":
            raise RuntimeError("not settled")

    identity = QueryIdentity(1, "writer", IDENTITY.server_uuids, "declared")
    tracker = QueryTracker(
        client, TARGET, identity, lock, QueryRecovery([table], settled, (  # type: ignore[arg-type]
            QueryTarget("app", "frozen", "00000000-0000-4000-8000-000000000003", "SharedMergeTree"),
        )),
    )
    context = (QueryContext("load.sql", 0, "INSERT INTO app.events SELECT id FROM app.frozen",
                            CONTEXT.before_retry) if fault == "source changed" else CONTEXT)
    compensation = ("TRUNCATE TABLE app.events SYNC" if fault == "unsupported SQL"
                    else "TRUNCATE TABLE app.events")
    if fault == "none":
        tracker.command(context, "compensation", compensation)
        tracker.command(context, "forward", context.forward_sql)
        assert client.events == [
            "metadata", "intent", "read-back", "compensation", "settled",
            "metadata", "intent", "read-back", "forward",
        ]
    else:
        def recover() -> None:
            tracker.command(context, "compensation", compensation)
            tracker.command(context, "forward", context.forward_sql)

        with pytest.raises((MigrateError, RuntimeError)):
            recover()
        assert "forward" not in client.events
        if fault in {"unsupported SQL", "changed UUID", "metadata denied"}:
            assert "intent" not in client.events
            assert "compensation" not in client.events
