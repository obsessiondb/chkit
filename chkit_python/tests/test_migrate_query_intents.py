"""Executable-SQL classification and durable migration query intent admission."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

import pytest

from chkit.cli.commands.migrate_lock import LockTarget
from chkit.cli.commands.migrate_query_intents import (
    QueryContext,
    QueryIdentity,
    QueryTracker,
    classify_query_intent,
)
from chkit.clickhouse.client import QueryResult

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
        match = re.search(r", '((?:[^'\\]|\\.)*)', '.*', false, \[\]$", sql)
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
    "INSERT INTO app.events SELECT * FROM app.view_of_distributed_table",
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
