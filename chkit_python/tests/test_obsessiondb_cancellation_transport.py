"""Assigned write ids and bounded cancellation requests over workbench."""

from __future__ import annotations

import threading
import time
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

    monkeypatch.setattr(remote_executor, "workbench_query_execute", execute)
    client().execute_tracked(
        "INSERT INTO t SELECT 1", check, intent,
        {"async_insert": 1, "query_id": "ignored", "log_comment": "kept"},
    )
    assert events == ["check", "intent", "check", "send"]
    assert calls == [{
        "service_slug": "benchmarks", "query": "INSERT INTO t SELECT 1",
        "query_id": "tracked-1", "settings": {"async_insert": 1, "log_comment": "kept"},
    }]


def test_tracked_write_defaults_to_synchronous_insert(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    def execute(_credentials: Credentials, **kwargs: Any) -> WorkbenchExecuteResult:
        calls.append(kwargs)
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    monkeypatch.setattr(remote_executor, "workbench_query_execute", execute)
    client().execute_tracked("INSERT INTO t SELECT 1", lambda: None, lambda: "sync-1")
    assert calls == [{
        "service_slug": "benchmarks", "query": "INSERT INTO t SELECT 1",
        "query_id": "sync-1", "settings": {"async_insert": 0},
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

    monkeypatch.setattr(remote_executor, "workbench_query_execute", execute)
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

    monkeypatch.setattr(remote_executor, "workbench_query_execute", execute)
    result = client().query_control("KILL QUERY WHERE query_id = 'old' SYNC", 1000, query_id="receipt-control", settings={"log_queries": 1, "query_id": "ignored"})
    assert result.rows == [{"kill_status": "finished"}]
    assert result.column_names == ["kill_status"]
    assert len(calls) == 1
    assert 0 < calls[0]["timeout"] <= 1
    assert calls[0]["query_id"] == "receipt-control"
    assert calls[0]["settings"]["log_queries"] == 1
    assert "query_id" not in calls[0]["settings"]


def test_control_deadline_bounds_a_stalled_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()

    def execute(_credentials: Credentials, **_kwargs: Any) -> WorkbenchExecuteResult:
        entered.set()
        release.wait(5)
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    monkeypatch.setattr(remote_executor, "workbench_query_execute", execute)
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

    monkeypatch.setattr(remote_executor, "workbench_query_execute", execute)
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

    monkeypatch.setattr(remote_executor, "workbench_query_execute", execute)
    if truncated:
        with pytest.raises(RuntimeError, match="truncated"):
            client().query_control("SELECT 0 AS n", 1000)
    else:
        assert client().query_control("SELECT 0 AS n", 1000).rows == [{"n": "0"}]
    assert calls[0]["settings"]["result_overflow_mode"] == "throw"
    assert calls[0]["settings"]["group_by_overflow_mode"] == "throw"
    assert client().query("SELECT 0 AS n").rows == [{"n": "0"}]
