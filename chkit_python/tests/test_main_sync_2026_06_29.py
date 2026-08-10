"""Tests for the 3 main-sync ports (see DRIFT.md > 'main sync 2026-06-29').

Covers:
- (#M1) User-Agent: ``chkit/<version>`` on all obsessiondb HTTP calls.
- (#M2) Backfill remote-execution guard: refuse plan/run/resume when
  authenticated + a service is selected (mirrors TS guardRemoteExecution).
- (#M3) ``whoami --json`` envelope shape parity + the shared
  json_envelope helpers (error_envelope / whoami_envelope /
  service_list_envelope).
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
    JSON_CONTRACT_VERSION,
    Credentials,
    SelectedService,
    _version,
    error_envelope,
    get_session,
    handle_backfill_command,
    list_service_organizations,
    save_credentials,
    save_selected_service,
    service_list_envelope,
    whoami_envelope,
)
from chkit_plugin_obsessiondb import (
    backfill_handler as obsessiondb_backfill_handler,
)
from chkit_plugin_obsessiondb.api_client import USER_AGENT

BASE = "https://api.test.obsessiondb.com"


# ---------- helpers ----------


def _cfg() -> ChxResolvedConfig:
    return ChxResolvedConfig(
        schema_=["./s.py"],
        out_dir=".",
        migrations_dir=".",
        meta_dir=".",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )


def _bf_ctx(
    *,
    command: str,
    flags: dict[str, Any],
    config_path: str | Path = "cfg.py",
    json_mode: bool = False,
    msgs: list[Any] | None = None,
) -> ChxOnBeforePluginCommandContext:
    return ChxOnBeforePluginCommandContext(
        target_plugin="backfill",
        command=command,
        config=_cfg(),
        config_path=str(config_path),
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


# ---------- #M1: User-Agent ----------


def test_M1_user_agent_constant_is_chkit_version() -> None:
    """The User-Agent must be ``chkit/<version>`` (not the bare 'chkit-cli')."""
    assert f"chkit/{_version.__version__}" == USER_AGENT
    assert USER_AGENT.startswith("chkit/")
    assert USER_AGENT != "chkit-cli"


def test_M1_user_agent_sent_on_get_session(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/api/auth/get-session",
        json={"user": {"id": "u", "email": "a@b.com", "name": "A"}},
    )
    get_session(BASE, "tok")
    request = httpx_mock.get_request()
    assert request is not None
    assert request.headers["User-Agent"] == USER_AGENT


def test_M1_user_agent_sent_on_rpc_post(
    isolated_home: Path, httpx_mock: HTTPXMock
) -> None:
    """RPC calls via service_api (and by extension jobs_api + workbench_api)
    also send the User-Agent.
    """
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    httpx_mock.add_response(
        url=f"{BASE}/rpc/services/listAll", json={"organizations": []}
    )
    list_service_organizations(Credentials(access_token="tok", base_url=BASE))
    request = httpx_mock.get_request()
    assert request is not None
    assert request.headers["User-Agent"] == USER_AGENT


# ---------- #M2: backfill remote-execution guard ----------


def test_M2_guard_returns_unhandled_when_not_authed(
    isolated_home: Path,
) -> None:
    """No creds → defer to the local backfill plugin (Phase-2 stub)."""
    result = handle_backfill_command(_bf_ctx(command="plan", flags={}))
    assert isinstance(result, ChxOnBeforePluginCommandUnhandled)


def test_M2_guard_returns_unhandled_when_authed_but_no_service(
    isolated_home: Path,
) -> None:
    """Authed but no service selected → defer (the user hasn't opted into
    ObsessionDB routing for this project)."""
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    result = handle_backfill_command(_bf_ctx(command="run", flags={}))
    assert isinstance(result, ChxOnBeforePluginCommandUnhandled)


def test_M2_guard_refuses_plan_when_authed_and_service_selected(
    isolated_home: Path, tmp_path: Path
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    config_path = tmp_path / "clickhouse.config.py"
    save_selected_service(
        config_path, SelectedService(service_slug="prod-eu", service_name="prod")
    )
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(command="plan", flags={}, config_path=config_path, msgs=msgs)
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 1
    assert any(
        "not supported directly against ObsessionDB" in str(m) for m in msgs
    )
    assert any("backfill submit" in str(m) for m in msgs)
    assert any("--local" in str(m) for m in msgs)


def test_M2_guard_refuses_run_when_service_flag_passed(
    isolated_home: Path,
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    msgs: list[Any] = []
    result = handle_backfill_command(
        _bf_ctx(command="run", flags={"--service": "prod-eu"}, msgs=msgs)
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 1


def test_M2_guard_json_mode_emits_error_envelope(
    isolated_home: Path, tmp_path: Path
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    config_path = tmp_path / "clickhouse.config.py"
    save_selected_service(
        config_path, SelectedService(service_slug="prod-eu", service_name="prod")
    )
    msgs: list[Any] = []
    handle_backfill_command(
        _bf_ctx(
            command="resume",
            flags={},
            config_path=config_path,
            json_mode=True,
            msgs=msgs,
        )
    )
    [payload] = msgs
    assert isinstance(payload, dict)
    assert payload["ok"] is False
    assert payload["command"] == "backfill resume"
    assert (
        "Backfill resume runs locally and is not supported directly against "
        "ObsessionDB" in payload["error"]
    )
    assert "chkit backfill submit" in payload["error"]
    assert "--local" in payload["error"]


def test_M2_local_flag_bypasses_guard_even_when_service_selected(
    isolated_home: Path, tmp_path: Path
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    config_path = tmp_path / "clickhouse.config.py"
    save_selected_service(
        config_path, SelectedService(service_slug="prod-eu", service_name="prod")
    )
    result = handle_backfill_command(
        _bf_ctx(
            command="plan",
            flags={"--local": True},
            config_path=config_path,
        )
    )
    # --local short-circuits to Unhandled, letting the local plugin's Phase-2
    # stub run (which will tell the user it isn't ported yet, separately).
    assert isinstance(result, ChxOnBeforePluginCommandUnhandled)


def test_M2_submit_is_not_guarded_routes_to_handle_submit_when_service_selected(
    isolated_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``submit`` targets ObsessionDB when authed + service selected: the
    handler invokes ``handle_submit`` instead of guarding."""
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    config_path = tmp_path / "clickhouse.config.py"
    save_selected_service(
        config_path, SelectedService(service_slug="prod-eu", service_name="prod")
    )
    captured: list[Any] = []

    def fake_handle_submit(context: Any) -> int:
        captured.append(context)
        return 0

    monkeypatch.setattr(
        obsessiondb_backfill_handler, "handle_submit", fake_handle_submit
    )
    result = handle_backfill_command(
        _bf_ctx(
            command="submit",
            flags={"--target": "app.events"},
            config_path=config_path,
        )
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 0
    [submit_ctx] = captured
    assert submit_ctx.service_slug == "prod-eu"
    assert submit_ctx.credentials.access_token == "tok"
    assert submit_ctx.flags == {"--target": "app.events"}


def test_M2_submit_propagates_handle_submit_exit_code(
    isolated_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    config_path = tmp_path / "clickhouse.config.py"
    save_selected_service(
        config_path, SelectedService(service_slug="prod-eu", service_name="prod")
    )
    monkeypatch.setattr(
        obsessiondb_backfill_handler, "handle_submit", lambda _ctx: 1
    )
    result = handle_backfill_command(
        _bf_ctx(
            command="submit",
            flags={"--target": "app.events"},
            config_path=config_path,
        )
    )
    assert isinstance(result, ChxOnBeforePluginCommandHandled)
    assert result.exit_code == 1


def test_M2_submit_unhandled_when_not_authed(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No creds → defer submit to the local command's guidance."""

    def fail_handle_submit(_ctx: Any) -> int:
        msg = "handle_submit must not be called without credentials"
        raise AssertionError(msg)

    monkeypatch.setattr(
        obsessiondb_backfill_handler, "handle_submit", fail_handle_submit
    )
    result = handle_backfill_command(
        _bf_ctx(command="submit", flags={"--target": "app.events"})
    )
    assert isinstance(result, ChxOnBeforePluginCommandUnhandled)


def test_M2_submit_unhandled_when_authed_but_no_service(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Authed but no service selected → nothing to submit to; defer."""
    save_credentials(Credentials(access_token="tok", base_url=BASE))

    def fail_handle_submit(_ctx: Any) -> int:
        msg = "handle_submit must not be called without a selected service"
        raise AssertionError(msg)

    monkeypatch.setattr(
        obsessiondb_backfill_handler, "handle_submit", fail_handle_submit
    )
    result = handle_backfill_command(
        _bf_ctx(command="submit", flags={"--target": "app.events"})
    )
    assert isinstance(result, ChxOnBeforePluginCommandUnhandled)


def test_M2_doctor_subcommand_is_NOT_guarded(
    isolated_home: Path, tmp_path: Path
) -> None:
    """``doctor`` reads local state and is fine with or without a service."""
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    config_path = tmp_path / "clickhouse.config.py"
    save_selected_service(
        config_path, SelectedService(service_slug="prod-eu", service_name="prod")
    )
    result = handle_backfill_command(
        _bf_ctx(command="doctor", flags={}, config_path=config_path)
    )
    # doctor isn't in _EXECUTION_SUBCOMMANDS and isn't in _REMOTE_SUBCOMMANDS
    # → handler returns Unhandled, lets the local plugin handle it.
    assert isinstance(result, ChxOnBeforePluginCommandUnhandled)


# ---------- #M3: json_envelope helpers ----------


def test_M3_error_envelope_shape() -> None:
    env = error_envelope("obsessiondb whoami", "bad_code", "Bad message")
    assert env == {
        "command": "obsessiondb whoami",
        "schemaVersion": JSON_CONTRACT_VERSION,
        "ok": False,
        "error": {"code": "bad_code", "message": "Bad message"},
    }


def test_M3_whoami_envelope_shape() -> None:
    env = whoami_envelope(email="a@b.com")
    assert env == {
        "command": "obsessiondb whoami",
        "schemaVersion": 1,
        "status": "logged_in",
        "email": "a@b.com",
        "next": None,
    }


def test_M3_whoami_envelope_ignores_name_for_forward_compat() -> None:
    """TS envelope intentionally omits ``name``; the helper accepts it but
    doesn't surface it — keeps the public payload narrow.
    """
    env = whoami_envelope(email="a@b.com", name="Alice")
    assert "name" not in env


def test_M3_service_list_envelope_shape() -> None:
    entry = {
        "organization": "Org",
        "slug": "prod-eu",
        "name": "prod",
        "selected": True,
    }
    env = service_list_envelope([entry])  # type: ignore[list-item]
    assert env == {
        "command": "obsessiondb service list",
        "schemaVersion": 1,
        "status": "ok",
        "services": [entry],
    }
