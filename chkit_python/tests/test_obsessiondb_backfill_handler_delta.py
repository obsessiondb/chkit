"""Backfill handler routing tests not covered elsewhere.

Ports the remaining ``packages/plugin-obsessiondb/src/backfill/handler.test.ts``
cases (401 session expiry, unknown subcommand while authed, successful remote
cancel/list routing). The rest of the TS file — including submit routing and
submit deferring to the local command — is covered by
``test_obsessiondb_phase4.py`` and ``test_main_sync_2026_06_29.py``.
"""

from __future__ import annotations

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
) -> ChxOnBeforePluginCommandContext:
    return ChxOnBeforePluginCommandContext(
        target_plugin="backfill",
        command=command,
        config=_cfg(),
        config_path="cfg.py",
        json_mode=False,
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
        _bf_ctx(command="list", flags={"--service-slug": SVC}, msgs=msgs)
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 0
    [printed] = msgs
    assert printed["total"] == 1
    assert printed["jobs"][0]["id"] == "job-1"
