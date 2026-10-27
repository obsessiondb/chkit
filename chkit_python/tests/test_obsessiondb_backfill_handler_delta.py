"""Backfill handler routing tests not covered elsewhere.

Ports the remaining ``packages/plugin-obsessiondb/src/backfill/handler.test.ts``
cases (401 session expiry, unknown subcommand while authed, successful remote
cancel/list routing, list defaulting to the selected service). The rest of the TS file — including submit routing and
submit deferring to the local command — is covered by
``test_obsessiondb_phase4.py`` and ``test_main_sync_2026_06_29.py``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pytest_httpx import HTTPXMock

from chkit.cli.table_scope import TableScope
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit.plugins import (
    ChxOnBeforePluginCommandContext,
    ChxOnBeforePluginCommandHandled,
    ChxOnBeforePluginCommandUnhandled,
)
from chkit_plugin_obsessiondb import (
    Credentials,
    handle_backfill_command,
    save_credentials,
)
from chkit_plugin_obsessiondb.storage import SelectedService, save_selected_service

BASE = "https://api.test.obsessiondb.com"
SVC = "svc-1"


def _cfg() -> ChxResolvedConfig:
    return ChxResolvedConfig(
        schema_=["./s.py"],
        out_dir=".",
        migrations_dir=".",
        meta_dir=".",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False,
            fail_on_checksum_mismatch=True,
            fail_on_drift=False,
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )


def _bf_ctx(
    *,
    command: str,
    flags: dict[str, Any],
    msgs: list[Any] | None = None,
    json_mode: bool = False,
    config_path: str = "cfg.py",
) -> ChxOnBeforePluginCommandContext:
    return ChxOnBeforePluginCommandContext(
        target_plugin="backfill",
        command=command,
        config=_cfg(),
        config_path=config_path,
        json_mode=json_mode,
        args=[],
        flags=flags,
        options={},
        table_scope=TableScope(enabled=False),
        print=(msgs.append if msgs is not None else lambda _v: None),
    )


@pytest.fixture
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg_dir = tmp_path / "xdg"
    cfg_dir.mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_dir))
    monkeypatch.delenv("OBSESSIONDB_API_URL", raising=False)
    return cfg_dir


def test_handler_401_prints_session_expired_message(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/get", status_code=401, text="Unauthorized"
    )
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(command="status", flags={"--job-id": "job-123"}, msgs=msgs)
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 1
    assert any("Session expired" in str(m) for m in msgs)


def test_handler_unhandled_for_unknown_subcommand_when_authed(
    isolated_home: Path,
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    result = handle_backfill_command(
        _bf_ctx(command="unknown-subcommand", flags={"--job-id": "job-123"})
    )
    assert isinstance(result, ChxOnBeforePluginCommandUnhandled)


def test_handler_routes_cancel_to_remote_jobs_cancel(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/cancel",
        json={"id": "job-456", "service_slug": SVC, "status": "cancelled"},
    )
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(command="cancel", flags={"--job-id": "job-456"}, msgs=msgs)
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 0
    assert len(msgs) == 1


def test_handler_routes_list_to_remote_jobs_list(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/list",
        json={
            "jobs": [
                {
                    "id": "job-1",
                    "serviceId": "svc-id-1",
                    "title": None,
                    "type": "backfill",
                    "target": "app.events",
                    "status": "completed",
                    "concurrency": 4,
                    "totalTasks": 3,
                    "completedTasks": 3,
                    "failedTasks": 0,
                    "createdAt": "2026-08-10T00:00:00Z",
                    "updatedAt": "2026-08-10T00:05:00Z",
                },
            ],
            "total": 1,
        },
    )
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(command="list", flags={"--service-slug": SVC}, msgs=msgs, json_mode=True)
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 0
    [printed] = msgs
    assert printed["command"] == "backfill list"
    assert printed["schemaVersion"] == 1
    assert printed["ok"] is True
    assert printed["total"] == 1
    assert printed["jobs"][0]["id"] == "job-1"


_LIST_RESPONSE = {
    "jobs": [
        {
            "id": "job-1",
            "serviceId": "svc-id-1",
            "title": None,
            "type": "backfill",
            "target": "table_a",
            "status": "completed",
            "concurrency": 2,
            "totalTasks": 5,
            "completedTasks": 5,
            "failedTasks": 0,
            "createdAt": "2026-03-28T00:00:00Z",
            "updatedAt": "2026-03-28T01:00:00Z",
        },
    ],
    "total": 1,
}


def test_handler_list_service_slug_overrides_selected_service(
    isolated_home: Path, tmp_path: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    config_path = _select_service(tmp_path)
    httpx_mock.add_response(url=f"{BASE}/rpc/jobs/list", json=_LIST_RESPONSE)
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(
            command="list",
            flags={"--service-slug": "other-svc"},
            msgs=msgs,
            config_path=config_path,
        )
    )
    assert result == ChxOnBeforePluginCommandHandled(exit_code=0)
    [request] = httpx_mock.get_requests()
    assert json.loads(request.content)["json"] == {"serviceSlug": "other-svc"}
    assert msgs == [
        "Backfill jobs for service other-svc (1):\n"
        "- job-1 table_a: completed (5/5 completed, 0 failed)"
    ]


def test_handler_list_defaults_to_selected_service(
    isolated_home: Path, tmp_path: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    config_path = _select_service(tmp_path)
    httpx_mock.add_response(url=f"{BASE}/rpc/jobs/list", json=_LIST_RESPONSE)
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(
            command="list", flags={}, msgs=msgs, json_mode=True, config_path=config_path
        )
    )
    assert result == ChxOnBeforePluginCommandHandled(exit_code=0)
    [request] = httpx_mock.get_requests()
    assert json.loads(request.content)["json"] == {"serviceSlug": SVC}
    [printed] = msgs
    assert printed["command"] == "backfill list"
    assert printed["ok"] is True
    assert printed["serviceSlug"] == SVC
    assert printed["total"] == 1


def _job_detail(**extra: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "job-123",
        "serviceId": "svc-id-1",
        "title": None,
        "type": "backfill",
        "target": "analytics.events",
        "status": "running",
        "concurrency": 4,
        "totalTasks": 10,
        "completedTasks": 3,
        "failedTasks": 0,
        "createdAt": "2026-03-29T00:00:00Z",
        "updatedAt": "2026-03-29T01:00:00Z",
        "maxRetries": 3,
        "workflowId": None,
        "metadata": None,
        "tasks": [],
    }
    payload.update(extra)
    return payload


def _failed_run(error: str, finished_at: str) -> dict[str, object]:
    return {
        "id": f"run-{finished_at}",
        "attempt": 1,
        "type": "insert",
        "status": "failed",
        "error": error,
        "startedAt": finished_at,
        "finishedAt": finished_at,
    }


def _select_service(tmp_path: Path) -> str:
    config_path = str(tmp_path / "clickhouse.config.py")
    save_selected_service(
        config_path, SelectedService(service_slug=SVC, service_name="My Service")
    )
    return config_path


def test_handler_prints_remote_job_status_as_text(
    isolated_home: Path, tmp_path: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    config_path = _select_service(tmp_path)
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/get",
        json=_job_detail(
            failedTasks=1,
            tasks=[
                {"id": "t1", "runs": [_failed_run("first failure", "2026-03-29T00:10:00Z")]},
                {"id": "t2", "runs": [_failed_run("Memory limit exceeded", "2026-03-29T00:20:00Z")]},
            ],
        ),
    )
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(
            command="status",
            flags={"--job-id": "job-123"},
            msgs=msgs,
            config_path=config_path,
        )
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 0
    assert msgs == [
        "Backfill job job-123 (analytics.events): running\n"
        "Tasks: 3/10 completed, 1 failed\n"
        "Last error: Memory limit exceeded\n"
        f"Track progress: https://api.test.obsessiondb.com/{SVC}/jobs/job-123"
    ]


def test_handler_wraps_remote_job_status_in_json_envelope(
    isolated_home: Path, tmp_path: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    config_path = _select_service(tmp_path)
    httpx_mock.add_response(url=f"{BASE}/rpc/jobs/get", json=_job_detail())
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(
            command="status",
            flags={"--job-id": "job-123"},
            msgs=msgs,
            json_mode=True,
            config_path=config_path,
        )
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 0
    [printed] = msgs
    assert printed["command"] == "backfill status"
    assert printed["schemaVersion"] == 1
    assert printed["ok"] is True
    assert printed["job"]["id"] == "job-123"
    assert printed["job"]["completedTasks"] == 3
    assert printed["lastError"] is None
    assert printed["url"] == f"https://api.test.obsessiondb.com/{SVC}/jobs/job-123"


def test_handler_confirms_remote_cancel_as_text(
    isolated_home: Path, tmp_path: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    config_path = _select_service(tmp_path)
    httpx_mock.add_response(url=f"{BASE}/rpc/jobs/cancel", json={})
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(
            command="cancel",
            flags={"--job-id": "job-456"},
            msgs=msgs,
            config_path=config_path,
        )
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 0
    assert msgs == [
        "Cancellation requested for backfill job job-456.\n"
        f"Track progress: https://api.test.obsessiondb.com/{SVC}/jobs/job-456"
    ]


def test_handler_wraps_remote_cancel_in_json_envelope(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    httpx_mock.add_response(url=f"{BASE}/rpc/jobs/cancel", json={})
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(
            command="cancel", flags={"--job-id": "job-456"}, msgs=msgs, json_mode=True
        )
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 0
    assert msgs == [
        {
            "command": "backfill cancel",
            "schemaVersion": 1,
            "ok": True,
            "jobId": "job-456",
            "url": None,
        }
    ]


def test_handler_reports_missing_login_as_json_error_envelope(
    isolated_home: Path,
) -> None:
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(
            command="status", flags={"--job-id": "job-123"}, msgs=msgs, json_mode=True
        )
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 1
    [printed] = msgs
    assert printed["command"] == "backfill status"
    assert printed["ok"] is False
    assert printed["error"]["code"] == "not_logged_in"
