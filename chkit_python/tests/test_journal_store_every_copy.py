"""#767 (round 5): a read of a replicated journal counts as a read of every
copy only when every member of the table's replica set answered it, by the
replica name the set records; the newest version across them is the record."""

from __future__ import annotations

from typing import Any

from chkit.cli.journal_store import EveryCopyRead, OperationState, every_copy_read


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
