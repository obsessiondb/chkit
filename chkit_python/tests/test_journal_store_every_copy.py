"""#767 (round 5): a read of a replicated journal counts as a read of every
copy only when every member of the table's replica set answered it, by the
replica name the set records; the newest version across them is the record."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, cast

import pytest

from chkit.cli.commands.migrate_async_apply import AsyncApplyInput, apply_async_statement
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.journal_store import EveryCopyRead, JournalStore, OperationState, every_copy_read
from chkit.clickhouse.client import QueryStatus


def _row(replica: str, applied_at: str, members: list[str] | None = None) -> dict[str, Any]:
    return {
        "replica": replica,
        "members": json.dumps(["r1", "r2"] if members is None else members),
        "present": 1,
        "applied_at": applied_at,
        "operations": applied_at,
        "operation_fingerprints": "[]",
    }


def _find_op(operations: Any, _fingerprints: Any) -> OperationState:
    return OperationState(
        operation_index=0,
        operation_key="k",
        operation_type="load_table_data",
        query_id="q",
        status="started",
        started_at="2026-11-18 10:00:00.000",
        finished_at=None,
        last_error=str(operations),
        fingerprint="",
    )


def test_every_member_answered_and_the_newest_version_is_the_record() -> None:
    read = every_copy_read(
        [_row("r1", "2026-11-18 10:00:00.000"), _row("r2", "2026-11-18 10:00:01.000")],
        _find_op,
    )
    assert read.covered
    assert read.op is not None
    assert read.op.last_error == "2026-11-18 10:00:01.000"


def test_two_servers_with_one_name_and_a_member_not_reached_are_not_covered() -> None:
    # The cluster lists r1 twice (a shared hostname) and never r2.
    rows = [_row("r1", "2026-11-18 10:00:00.000"), _row("r1", "2026-11-18 10:00:00.000")]
    assert every_copy_read(rows, _find_op) == EveryCopyRead(covered=False, op=None)


def test_a_duplicate_reply_covering_every_member_is_not_covered() -> None:
    rows = [_row("r1", "a"), _row("r2", "b"), _row("r2", "b")]
    assert not every_copy_read(rows, _find_op).covered


def test_a_replica_set_that_is_not_a_json_array_of_names_is_not_covered() -> None:
    assert not every_copy_read([{**_row("r1", "a"), "members": "r1"}], _find_op).covered
    assert not every_copy_read([{**_row("r1", "a"), "members": '[""]'}], _find_op).covered


def test_a_server_without_a_replica_name_or_no_answer_is_not_covered() -> None:
    assert not every_copy_read([_row("r1", "a"), _row("", "b")], _find_op).covered
    assert not every_copy_read([], _find_op).covered
    assert not every_copy_read([_row("r1", "a", [])], _find_op).covered


def test_no_copy_holds_the_record_is_covered_without_one() -> None:
    rows = [{**_row("r1", ""), "present": "0"}, {**_row("r2", ""), "present": "0"}]
    assert every_copy_read(rows, _find_op) == EveryCopyRead(covered=True, op=None)


# #767 (round 6): the topology of an every-copy read is read fresh, in the
# same query, and only positive evidence of a single server counts a journal
# that is not replicated as one copy.
_PREPARED = json.dumps(
    [
        {
            "operation_index": 0,
            "operation_key": "k",
            "operation_type": "load_table_data",
            "query_id": "qid",
            "status": "started",
            "started_at": "2026-11-18 10:00:00.000",
            "finished_at": None,
            "last_error": "prepared under its own query id; not submitted yet",
        }
    ]
)
_UUID_A = "2dea4dea-c7d6-439c-b8ef-5eaa1d275f14"
_UUID_B = "6f1c2a9e-0b7d-4f3e-9a51-3c8d2e7b4a10"


def _copy(replica: str) -> dict[str, Any]:
    # As the Workbench API returns it: every cell a string.
    return {
        "replica": replica,
        "members": json.dumps([replica]),
        "present": "1",
        "applied_at": "2026-11-18 10:00:00.000",
        "operations": _PREPARED,
        "operation_fingerprints": "[]",
    }


@dataclass
class _Result:
    rows: list[dict[str, Any]]


@dataclass
class _TopologyClient:
    every_copy: Callable[[], list[dict[str, Any]]]
    engine: str = "ReplacingMergeTree"
    reads: list[str] = field(default_factory=list)
    read_settings: list[dict[str, Any] | None] = field(default_factory=list)

    def query(self, sql: str, settings: dict[str, Any] | None = None) -> _Result:
        if "SELECT engine FROM system.tables" in sql:
            return _Result([{"engine": self.engine}])
        if "currentDatabase() AS database" in sql:
            return _Result([{"database": "db"}])
        if "view(" in sql:
            self.reads.append(sql)
            self.read_settings.append(settings)
            return _Result(self.every_copy())
        return _Result([])

    def execute(self, sql: str, settings: dict[str, Any] | None = None) -> None:
        _ = (sql, settings)


def _store(
    every_copy: Callable[[], list[dict[str, Any]]], engine: str = "ReplacingMergeTree"
) -> tuple[JournalStore, _TopologyClient]:
    client = _TopologyClient(every_copy, engine)
    return JournalStore(cast(Any, client)), client


def test_one_server_answering_with_string_cells_is_covered_with_its_prepared_record() -> None:
    store, client = _store(lambda: [_copy(_UUID_A)])
    read = store.read_operation_on_every_copy("m.sql", 0)
    assert read.covered
    assert read.op is not None
    assert read.op.query_id == "qid"
    assert read.op.last_error == "prepared under its own query id; not submitted yet"
    assert "clusterAllReplicas('default', view(SELECT toString(serverUUID())" in client.reads[0]
    # An unavailable server fails the read; no limit cuts the reply short.
    settings = client.read_settings[0] or {}
    assert settings["skip_unavailable_shards"] == 0
    assert settings["result_overflow_mode"] == "throw"
    assert settings["read_overflow_mode"] == "throw"


def test_a_replicated_read_with_string_cells_is_covered_with_its_record() -> None:
    store, _ = _store(
        lambda: [
            {**_copy("ch1"), "members": '["ch1","ch2"]'},
            {**_copy("ch2"), "members": '["ch1","ch2"]'},
        ],
        engine="ReplicatedReplacingMergeTree",
    )
    read = store.read_operation_on_every_copy("m.sql", 0)
    assert read.covered
    assert read.op is not None
    assert read.op.query_id == "qid"


def test_one_server_replying_twice_or_without_a_server_uuid_is_not_covered() -> None:
    assert not _store(lambda: [_copy(_UUID_A), _copy(_UUID_A)])[0].read_operation_on_every_copy(
        "m.sql", 0
    ).covered
    assert not _store(lambda: [_copy("uuid-a")])[0].read_operation_on_every_copy(
        "m.sql", 0
    ).covered


@pytest.mark.parametrize(
    "error",
    [
        RuntimeError("Not enough privileges. (ACCESS_DENIED)"),
        RuntimeError("Requested cluster 'default' not found"),
    ],
)
def test_a_cluster_denied_or_missing_fails_the_read(error: Exception) -> None:
    def fail() -> list[dict[str, Any]]:
        raise error

    store, _ = _store(fail)
    with pytest.raises(RuntimeError):
        store.read_operation_on_every_copy("m.sql", 0)


def test_two_servers_behind_one_hostname_are_not_covered() -> None:
    store, _ = _store(lambda: [_copy(_UUID_A), _copy(_UUID_B)])
    assert store.read_operation_on_every_copy("m.sql", 0) == EveryCopyRead(covered=False, op=None)


def test_a_server_added_after_the_first_read_is_not_covered_on_the_next() -> None:
    servers = [_copy(_UUID_A)]
    store, client = _store(lambda: servers)
    assert store.read_operation_on_every_copy("m.sql", 0).covered
    servers.append(_copy(_UUID_B))
    assert not store.read_operation_on_every_copy("m.sql", 0).covered
    assert len(client.reads) == 2


class _RecoveryClient(_TopologyClient):
    """A target whose journal holds a prepared attempt that nothing ran."""

    submitted: list[str]

    def query(self, sql: str, settings: dict[str, Any] | None = None) -> _Result:
        if "now_ms" in sql:
            return _Result([{"now_ms": "1700000000000", "database": "db"}])
        if "FINAL WHERE" in sql:
            return _Result(
                [
                    {
                        "name": "m.sql",
                        "applied_at": "2026-05-26 10:00:00.000",
                        "checksum": "abc",
                        "chkit_version": "",
                        "migration_completed": "false",
                        "operations": _PREPARED,
                    }
                ]
            )
        return super().query(sql, settings)

    def query_status(self, query_id: str, **kwargs: Any) -> QueryStatus:
        _ = (query_id, kwargs)
        return QueryStatus(status="unknown")

    def submit(self, statement: str, *args: Any, **kwargs: Any) -> str:
        _ = (args, kwargs)
        self.submitted.append(statement)
        return "x"


def _unreachable() -> list[dict[str, Any]]:
    msg = "Code: 279. ALL_CONNECTION_TRIES_FAILED"
    raise RuntimeError(msg)


@pytest.mark.parametrize(
    "every_copy",
    [lambda: [_copy(_UUID_A), _copy(_UUID_A)], _unreachable],
    ids=["one-server-twice", "added-server-unreachable"],
)
def test_recovery_through_the_journal_store_submits_nothing(
    every_copy: Callable[[], list[dict[str, Any]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 7): through the real journal store, a fan-out that answers
    one server twice, or that a server added since cannot answer, never lets a
    prepared attempt run again: the run stops with nothing submitted."""
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _s: None)
    client = _RecoveryClient(every_copy)
    client.submitted = []
    store = JournalStore(cast(Any, client))
    with pytest.raises(MigrateError) as info:
        apply_async_statement(
            AsyncApplyInput(
                client=cast(Any, client),
                journal_store=store,
                sql="INSERT INTO t SELECT 1",
                migration_name="m.sql",
                migration_checksum="abc",
                statement_index=0,
                operation_type="load_table_data",
                operation_key="k",
                fingerprint="",
                before_retry=None,
                log=lambda _line: None,
                poll_interval_seconds=0.0,
            )
        )
    assert info.value.code == "async_outcome_unknown"
    assert "query_id qid" in info.value.message
    assert client.submitted == []
