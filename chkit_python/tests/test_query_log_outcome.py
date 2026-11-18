"""#767 (Opus review): every query_log entry of the id decides its outcome."""

from __future__ import annotations

from typing import Any

import pytest

from chkit.clickhouse.client import QueryResult, QueryStatus, query_log_outcome
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.remote_executor import RemoteClickHouseClient


def _row(type_: str, **overrides: Any) -> dict[str, Any]:
    return {
        "type": type_,
        "written_rows": "1",
        "written_bytes": "8",
        "query_duration_ms": "10",
        "exception": "",
        "exception_code": "0",
        **overrides,
    }


_DUPLICATE = _row(
    "ExceptionBeforeStart",
    exception="Code: 216. QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING",
    exception_code="216",
)


def test_a_query_finish_outranks_a_newer_duplicate_delivery_rejection() -> None:
    assert query_log_outcome([_DUPLICATE, _row("QueryFinish")]) == QueryStatus(
        status="finished", written_rows=1, written_bytes=8, duration_ms=10
    )


def test_one_entry_returned_twice_by_a_node_listed_twice_is_one_entry() -> None:
    """#767 (Opus re-review): a fan-out that lists one node twice returns its
    entry twice; that is one run."""
    once = _row("QueryFinish", server="uuid-a", event_at="2026-11-19 00:00:00.000001")
    assert query_log_outcome([once, dict(once)]).status == "finished"
    assert query_log_outcome([once, {**once, "server": "uuid-b"}]) == QueryStatus(
        status="unknown"
    )


def test_two_terminal_entries_of_one_id_are_unknown() -> None:
    """#767 (Opus re-review): a redelivered request that ran twice logs two
    terminal entries; a partial ExceptionWhileProcessing beside a QueryFinish
    says some writes may have been applied twice, so neither decides."""
    unknown = QueryStatus(status="unknown")
    partial = _row("ExceptionWhileProcessing", exception="Code: 241")
    assert query_log_outcome([_row("QueryFinish"), partial]) == unknown
    rejected = _row("ExceptionBeforeStart", exception="Code: 60")
    assert query_log_outcome([rejected, _row("QueryFinish")]) == unknown
    twice = [_row("QueryFinish", event_at="1"), _row("QueryFinish", event_at="2")]
    assert query_log_outcome([_DUPLICATE, *twice]) == unknown


def test_a_duplicate_delivery_is_no_failure_of_the_query() -> None:
    assert query_log_outcome([_DUPLICATE]) == QueryStatus(status="unknown")
    status = query_log_outcome([_DUPLICATE, _row("ExceptionBeforeStart", exception="Code: 60")])
    assert (status.status, status.error, status.before_start) == ("failed", "Code: 60", True)


def test_no_entry_is_unknown() -> None:
    assert query_log_outcome([]) == QueryStatus(status="unknown")


def test_the_remote_executor_reads_every_entry_with_before_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ObsessionDB remote executor reads every entry of the id when
    ExceptionBeforeStart counts, and a duplicate delivery's rejection never
    hides the attempt's QueryFinish."""
    remote = RemoteClickHouseClient(
        credentials=Credentials(access_token="t", base_url="http://127.0.0.1:9"),
        service_slug="svc",
    )
    reads: list[str] = []

    def query(
        _self: RemoteClickHouseClient, statement: str, settings: dict[str, Any] | None = None
    ) -> QueryResult:
        _ = settings
        reads.append(statement)
        if "system.one" in statement:
            return QueryResult(column_names=["replicas"], rows=[{"replicas": "1"}])
        if "system.query_log" in statement:
            rows = [_DUPLICATE, _row("QueryFinish", written_rows="25")]
            return QueryResult(column_names=list(rows[0]), rows=rows)
        return QueryResult(column_names=[], rows=[])

    monkeypatch.setattr(RemoteClickHouseClient, "query", query)
    status = remote.query_status("qid-1", include_before_start=True)
    assert status.status == "finished"
    assert status.written_rows == 25
    log_read = next(statement for statement in reads if "system.query_log" in statement)
    assert "LIMIT 1" not in log_read


def test_the_remote_executor_finds_two_terminal_entries_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote = RemoteClickHouseClient(
        credentials=Credentials(access_token="t", base_url="http://127.0.0.1:9"),
        service_slug="svc",
    )

    def query(
        _self: RemoteClickHouseClient, statement: str, settings: dict[str, Any] | None = None
    ) -> QueryResult:
        _ = settings
        if "system.one" in statement:
            return QueryResult(column_names=["replicas"], rows=[{"replicas": "1"}])
        if "system.query_log" in statement:
            rows = [_row("QueryFinish"), _row("ExceptionWhileProcessing", exception="Code: 241")]
            return QueryResult(column_names=list(rows[0]), rows=rows)
        return QueryResult(column_names=[], rows=[])

    monkeypatch.setattr(RemoteClickHouseClient, "query", query)
    assert remote.query_status("qid-1", include_before_start=True) == QueryStatus(
        status="unknown"
    )
