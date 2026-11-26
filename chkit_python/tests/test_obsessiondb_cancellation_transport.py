"""Assigned write ids and bounded cancellation requests over workbench."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

import pytest
from pytest_httpx import HTTPXMock

from chkit_plugin_obsessiondb import remote_executor
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.remote_executor import RemoteClickHouseClient
from chkit_plugin_obsessiondb.workbench_api import (
    WorkbenchColumn,
    WorkbenchExecuteResult,
    workbench_query_execute,
)

_CHANGEABLE: list[list[str]] = [["readonly", "0", "0"], ["async_insert", "1", "0"], ["wait_for_async_insert", "0", "0"]]


def _answering_lookup(
    execute: Callable[..., WorkbenchExecuteResult], *, rows: list[list[str]] | None = None
) -> Callable[..., WorkbenchExecuteResult]:
    """``execute``, with the writes' settings lookup answered apart: rows of
    (name, value, readonly), every setting changeable by default."""

    def wrapped(credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        if "FROM system.settings" in kwargs["query"]:
            data = _CHANGEABLE if rows is None else rows
            return WorkbenchExecuteResult(
                data=list(data),
                meta=[WorkbenchColumn(name=name, type="String") for name in ("name", "value", "readonly")],
                rows=len(data),
            )
        return execute(credentials, **kwargs)

    return wrapped


def client() -> RemoteClickHouseClient:
    return RemoteClickHouseClient(
        credentials=Credentials(access_token="test", base_url="https://api.test"),
        service_slug="benchmarks",
    )


def test_tracked_write_records_before_send_and_preserves_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    calls: list[dict[str, Any]] = []

    def execute(_credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        events.append("send")
        calls.append(kwargs)
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    def check() -> None:
        events.append("check")

    def intent() -> str:
        assert calls == []
        events.append("intent")
        return "tracked-1"

    monkeypatch.setattr(remote_executor, "workbench_query_execute", _answering_lookup(execute))
    client().execute_tracked(
        "INSERT INTO t SELECT 1", check, intent,
        {"async_insert": 1, "query_id": "ignored", "log_comment": "kept"},
    )
    assert events == ["check", "intent", "check", "send"]
    assert calls == [{
        "service_slug": "benchmarks", "query": "INSERT INTO t SELECT 1",
        "query_id": "tracked-1",
        "settings": {"async_insert": 1, "wait_for_async_insert": 1, "log_comment": "kept"},
    }]


def test_tracked_write_sends_the_durable_insert_settings_under_the_callers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Like the native path, a tracked write sends the durable-insert settings
    under the caller's; recovery forces async_insert = 0 over them (#733 review G)."""
    calls: list[dict[str, Any]] = []

    def execute(_credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        calls.append(kwargs)
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    monkeypatch.setattr(remote_executor, "workbench_query_execute", _answering_lookup(execute))
    client().execute_tracked("INSERT INTO t SELECT 1", lambda: None, lambda: "sync-1")
    assert calls == [{
        "service_slug": "benchmarks", "query": "INSERT INTO t SELECT 1",
        "query_id": "sync-1", "settings": {"async_insert": 0, "wait_for_async_insert": 1},
    }]


def test_tracked_write_refuses_send_after_ownership_loss(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    held = True
    calls: list[dict[str, Any]] = []

    def execute(_credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        calls.append(kwargs)
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    def check() -> None:
        if not held:
            raise RuntimeError("lost ownership")

    def intent() -> str:
        nonlocal held
        held = False
        return "tracked-2"

    monkeypatch.setattr(remote_executor, "workbench_query_execute", _answering_lookup(execute))
    with pytest.raises(RuntimeError, match="lost ownership"):
        client().execute_tracked("TRUNCATE TABLE t", check, intent)
    assert calls == []


def test_control_decodes_rows_and_sets_remaining_http_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def execute(_credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        calls.append(kwargs)
        return WorkbenchExecuteResult(
            data=[["finished"]], meta=[WorkbenchColumn(name="kill_status", type="String")], rows=1,
        )

    monkeypatch.setattr(remote_executor, "workbench_query_execute", _answering_lookup(execute))
    result = client().query_control("KILL QUERY WHERE query_id = 'old' SYNC", 1000, query_id="receipt-control", settings={"log_queries": 1, "query_id": "ignored", "use_query_cache": 1, "enable_reads_from_query_cache": 1, "enable_writes_to_query_cache": 1})
    assert result.rows == [{"kill_status": "finished"}]
    assert result.column_names == ["kill_status"]
    assert len(calls) == 1
    assert 0 < calls[0]["timeout"] <= 1
    assert calls[0]["query_id"] == "receipt-control"
    assert calls[0]["settings"]["log_queries"] == 1
    assert "query_id" not in calls[0]["settings"]
    cache_settings = {"use_query_cache": 1, "enable_reads_from_query_cache": 1, "enable_writes_to_query_cache": 1}
    for name in cache_settings:
        assert calls[0]["settings"][name] == 0
    client().query("SELECT 1", settings=cache_settings)
    assert calls[1]["settings"] == cache_settings


def test_control_deadline_bounds_a_stalled_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()

    def execute(_credentials: Credentials, **_kwargs: Any) -> WorkbenchExecuteResult:
        entered.set()
        release.wait(5)
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    monkeypatch.setattr(remote_executor, "workbench_query_execute", _answering_lookup(execute))
    started = time.monotonic()
    try:
        with pytest.raises(TimeoutError, match="deadline expired"):
            client().query_control("SELECT 1", 50)
        assert entered.is_set()
        assert time.monotonic() - started < 2
    finally:
        release.set()


def test_control_propagates_server_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def execute(_credentials: Credentials, **_kwargs: Any) -> WorkbenchExecuteResult:
        return WorkbenchExecuteResult(data=[], meta=[], rows=0, error="ACCESS_DENIED")

    monkeypatch.setattr(remote_executor, "workbench_query_execute", _answering_lookup(execute))
    with pytest.raises(RuntimeError, match="ACCESS_DENIED"):
        client().query_control("SELECT 1", 1000)


def test_workbench_control_timeout_reaches_http_transport(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(json={"json": {"data": [], "meta": [], "rows": 0}})
    workbench_query_execute(
        Credentials(access_token="test", base_url="https://api.test"),
        service_slug="benchmarks", query="SELECT 1", timeout=0.25,
    )
    [request] = httpx_mock.get_requests()
    assert request.extensions["timeout"] == {
        "connect": 0.25, "read": 0.25, "write": 0.25, "pool": 0.25,
    }


@pytest.mark.parametrize("truncated", [True, False])
def test_control_refuses_truncated_workbench_results(
    truncated: bool, monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def execute(_credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        calls.append(kwargs)
        return WorkbenchExecuteResult.model_validate({
            "data": [["0"]], "meta": [{"name": "n", "type": "UInt64"}], "rows": 1,
            "truncated": truncated,
        })

    monkeypatch.setattr(remote_executor, "workbench_query_execute", _answering_lookup(execute))
    if truncated:
        with pytest.raises(RuntimeError, match="truncated"):
            client().query_control("SELECT 0 AS n", 1000)
    else:
        assert client().query_control("SELECT 0 AS n", 1000).rows == [{"n": "0"}]
    assert calls[0]["settings"]["result_overflow_mode"] == "throw"
    assert calls[0]["settings"]["group_by_overflow_mode"] == "throw"
    assert client().query("SELECT 0 AS n").rows == [{"n": "0"}]


def test_writes_leave_out_settings_the_profile_locks_at_the_durable_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A profile that locks a setting rejects any change of it, also on DDL
    (#804). Looked up once. TS: remote-executor.test.ts."""
    calls: list[dict[str, Any]] = []
    lookups: list[str] = []

    def execute(_credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        calls.append(kwargs)
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    answering = _answering_lookup(
        execute, rows=[["async_insert", "0", "1"], ["wait_for_async_insert", "1", "1"]]
    )

    def counted(credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        if "FROM system.settings" in kwargs["query"]:
            lookups.append(kwargs["query"])
        return answering(credentials, **kwargs)

    monkeypatch.setattr(remote_executor, "workbench_query_execute", counted)
    remote = client()
    remote.execute("CREATE TABLE t (id UInt64) ENGINE = MergeTree ORDER BY id")
    remote.insert("t", [{"id": 1}])
    remote.execute_tracked("INSERT INTO t VALUES (2)", lambda: None, lambda: "tracked-locked")
    remote.submit("INSERT INTO t VALUES (3)", "qid-locked")
    assert [call.get("settings") for call in calls] == [None, None, None, None]
    assert len(lookups) == 1


def test_no_write_is_sent_when_the_async_insert_lookup_fails_and_it_is_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def execute(_credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        calls.append(kwargs)
        if "FROM system.settings" in kwargs["query"]:
            return WorkbenchExecuteResult(
                data=[], meta=[], rows=0, error="Code: 497. ACCESS_DENIED"
            )
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    monkeypatch.setattr(remote_executor, "workbench_query_execute", execute)
    remote = client()
    for _ in range(2):
        with pytest.raises(RuntimeError, match="ACCESS_DENIED"):
            remote.execute("DROP TABLE t")
    assert [call["query"] for call in calls] == [
        "SELECT name, value, toString(readonly) AS readonly FROM system.settings "
        "WHERE name IN ('readonly', 'async_insert', 'wait_for_async_insert')",
    ] * 2


def test_a_write_is_refused_when_the_profile_fixes_a_durable_setting_elsewhere(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def execute(_credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        calls.append(kwargs)
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    monkeypatch.setattr(
        remote_executor,
        "workbench_query_execute",
        _answering_lookup(
            execute, rows=[["async_insert", "1", "1"], ["wait_for_async_insert", "1", "0"]]
        ),
    )
    remote = client()
    with pytest.raises(RuntimeError) as info:
        remote.execute("CREATE TABLE t (id UInt64) ENGINE = MergeTree ORDER BY id")
    assert str(info.value) == (
        "Setting async_insert is fixed at 1 for this ClickHouse user, and chkit "
        "writes need async_insert = 0 to be stored when they return."
    )
    with pytest.raises(RuntimeError, match="Setting async_insert is fixed at 1"):
        remote.submit("INSERT INTO t VALUES (1)", "qid-refused")
    assert calls == []


def test_a_readonly_user_write_goes_without_settings_for_the_server_to_refuse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def execute(_credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        calls.append(kwargs)
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    monkeypatch.setattr(
        remote_executor,
        "workbench_query_execute",
        _answering_lookup(
            execute,
            rows=[["readonly", "1", "0"], ["async_insert", "1", "1"],
                  ["wait_for_async_insert", "0", "1"]],
        ),
    )
    client().execute("DROP TABLE t")
    assert calls == [{"service_slug": "benchmarks", "query": "DROP TABLE t", "settings": None}]
