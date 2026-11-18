"""#767 (round 5): a read of a replicated journal counts as a read of every
copy only when every member of the table's replica set answered it, by the
replica name the set records; the newest version across them is the record."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, cast

import pytest

from chkit.cli.journal_store import EveryCopyRead, JournalStore, OperationState, every_copy_read


def _row(replica: str, applied_at: str, members: list[str] | None = None) -> dict[str, Any]:
    return {
        "replica": replica,
        "members": ["r1", "r2"] if members is None else members,
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
        [
            0,
            "k",
            "load_table_data",
            "qid",
            "started",
            "2026-11-18 10:00:00.000",
            None,
            "prepared under its own query id; not submitted yet",
        ]
    ]
)


def _copy(replica: str) -> dict[str, Any]:
    return {
        "replica": replica,
        "members": [replica],
        "present": 1,
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
    reads: list[str] = field(default_factory=list)

    def query(self, sql: str, settings: dict[str, Any] | None = None) -> _Result:
        _ = settings
        if "SELECT engine FROM system.tables" in sql:
            return _Result([{"engine": "ReplacingMergeTree"}])
        if "currentDatabase() AS database" in sql:
            return _Result([{"database": "db"}])
        if "view(" in sql:
            self.reads.append(sql)
            return _Result(self.every_copy())
        return _Result([])

    def execute(self, sql: str, settings: dict[str, Any] | None = None) -> None:
        _ = (sql, settings)


def _store(every_copy: Callable[[], list[dict[str, Any]]]) -> tuple[JournalStore, _TopologyClient]:
    client = _TopologyClient(every_copy)
    return JournalStore(cast(Any, client)), client


def test_one_server_answering_is_covered_with_its_record() -> None:
    store, client = _store(lambda: [_copy("uuid-a")])
    read = store.read_operation_on_every_copy("m.sql", 0)
    assert read.covered
    assert "clusterAllReplicas('default', view(SELECT toString(serverUUID())" in client.reads[0]


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
    store, _ = _store(lambda: [_copy("uuid-a"), _copy("uuid-b")])
    assert store.read_operation_on_every_copy("m.sql", 0) == EveryCopyRead(covered=False, op=None)


def test_a_server_added_after_the_first_read_is_not_covered_on_the_next() -> None:
    servers = [_copy("uuid-a")]
    store, client = _store(lambda: servers)
    assert store.read_operation_on_every_copy("m.sql", 0).covered
    servers.append(_copy("uuid-b"))
    assert not store.read_operation_on_every_copy("m.sql", 0).covered
    assert len(client.reads) == 2
