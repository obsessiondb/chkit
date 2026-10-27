"""``--json`` error envelopes carry the raised error's stable ``code`` (#312).

Like ``toJsonError`` in the TS CLI, any error with a string ``code``
attribute (``MigrateError``, ``ServiceNotFoundError``, ...) reports that code;
every other error reports ``"error"``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pytest_httpx import HTTPXMock
from typer.testing import CliRunner

from chkit.cli.commands import migrate, snapshot
from chkit.cli.json_output import json_error_code
from chkit.cli.main import app
from chkit.cli.table_scope import TableScope
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit.plugins import (
    ChxOnBeforePluginCommandContext,
    ChxOnBeforePluginCommandHandled,
)
from chkit_plugin_obsessiondb import (
    Credentials,
    handle_backfill_command,
    save_credentials,
)
from chkit_plugin_obsessiondb.service_api import ServiceNotFoundError

BASE = "https://api.test.obsessiondb.com"


class _IntCodeError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("int code")
        self.code = 7


def test_json_error_code_uses_a_string_code_attribute() -> None:
    error = ServiceNotFoundError("gone", code="service_not_in_active_organization")
    assert json_error_code(error) == "service_not_in_active_organization"


def test_json_error_code_falls_back_to_error() -> None:
    assert json_error_code(RuntimeError("boom")) == "error"
    assert json_error_code(_IntCodeError()) == "error"


def _raise_service_not_found(*_args: Any, **_kwargs: Any) -> Any:
    raise ServiceNotFoundError(
        'obsessiondb: service "gone" was not found in any organization you can access.',
        code="service_not_found",
    )


@pytest.mark.parametrize("command", ["migrate", "snapshot"])
def test_cli_json_envelope_carries_the_service_not_found_code(
    command: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    module = migrate if command == "migrate" else snapshot
    monkeypatch.setattr(module, "load_config", _raise_service_not_found)
    args = [command, "rebuild", "--json"] if command == "snapshot" else [command, "--json"]

    result = CliRunner().invoke(app, args)

    assert result.exit_code == 1
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is False
    assert envelope["command"] == command
    assert envelope["error"] == {
        "code": "service_not_found",
        "message": (
            'obsessiondb: service "gone" was not found in any organization you can access.'
        ),
    }


def test_cli_json_envelope_keeps_error_for_errors_without_a_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)

    def _boom(*_args: Any, **_kwargs: Any) -> Any:
        msg = "boom"
        raise RuntimeError(msg)

    monkeypatch.setattr(migrate, "load_config", _boom)

    result = CliRunner().invoke(app, ["migrate", "--json"])

    assert result.exit_code == 1
    assert json.loads(result.stdout)["error"] == {"code": "error", "message": "boom"}


# ---------- backfill status --service-slug through the ObsessionDB jobs API ----------


@pytest.fixture
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg_dir = tmp_path / "xdg"
    cfg_dir.mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_dir))
    monkeypatch.delenv("OBSESSIONDB_API_URL", raising=False)
    return cfg_dir


def _org(*, org_id: str, name: str, slugs: list[str]) -> dict[str, Any]:
    return {
        "id": org_id,
        "name": name,
        "slug": org_id,
        "services": [
            {
                "id": f"id-{slug}",
                "slug": slug,
                "name": slug,
                "status": "running",
                "tier": 1,
                "nodes": 1,
                "connectionUrl": None,
                "connectionUsername": None,
                "desiredStatus": "running",
                "desiredTier": 1,
                "desiredNodes": 1,
                "createdAt": "2026-01-01T00:00:00Z",
                "managed": True,
            }
            for slug in slugs
        ],
    }


def _mock_jobs_list_404(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/rpc/jobs/list", status_code=404, json={"error": "Service not found"}
    )
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/listAll",
        json={
            "json": {
                "organizations": [
                    _org(org_id="org-acme", name="Acme", slugs=["prod"]),
                    _org(org_id="org-bench", name="Benchmarks", slugs=["benchmarks"]),
                ]
            }
        },
    )
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={
            "user": {"id": "u1", "name": "User", "email": "user@example.test"},
            "session": {"activeOrganizationId": "org-acme"},
        },
    )


def _list_jobs(service_slug: str) -> tuple[int, list[Any]]:
    msgs: list[Any] = []
    result = handle_backfill_command(
        ChxOnBeforePluginCommandContext(
            target_plugin="backfill",
            command="status",
            config=ChxResolvedConfig(
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
            ),
            config_path="cfg.py",
            json_mode=True,
            args=[],
            flags={"--service-slug": service_slug},
            options={},
            table_scope=TableScope(enabled=False),
            print=msgs.append,
        )
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    return result.exit_code, msgs


@pytest.mark.parametrize(
    ("service_slug", "code"),
    [
        ("benchmarks", "service_not_in_active_organization"),
        ("gone", "service_not_found"),
    ],
)
def test_backfill_status_json_envelope_carries_the_service_not_found_code(
    isolated_home: Path, httpx_mock: HTTPXMock, service_slug: str, code: str
) -> None:
    _ = isolated_home
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    _mock_jobs_list_404(httpx_mock)

    exit_code, msgs = _list_jobs(service_slug)

    assert exit_code == 1
    [printed] = msgs
    assert printed["command"] == "backfill status"
    assert printed["ok"] is False
    assert printed["error"]["code"] == code
    assert f'service "{service_slug}"' in printed["error"]["message"]


def test_backfill_status_json_envelope_keeps_error_for_a_plain_failure(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    _ = isolated_home
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    httpx_mock.add_response(url=f"{BASE}/rpc/jobs/list", status_code=500, text="boom")

    exit_code, msgs = _list_jobs("prod")

    assert exit_code == 1
    [printed] = msgs
    assert printed["error"] == {
        "code": "error",
        "message": "RPC jobs/list failed: 500 boom",
    }
