"""Tests for `chkit_plugin_obsessiondb` plugin factory + onboarding + storage."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit import ColumnDefinition, table
from chkit.cli.main import app
from chkit.cli.plugin_runtime import load_plugin_runtime
from chkit.cli.table_scope import TableScope
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedClickHouseConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit.plugins import ChxOnSchemaLoadedContext, ChxPluginManifest
from chkit_plugin_obsessiondb import (
    Credentials,
    SelectedService,
    create_obsessiondb_plugin,
    get_credentials_path,
    load_credentials,
    load_selected_service,
    load_service_aliases,
    obsessiondb,
    resolve_base_url,
    run_onboarding,
    save_credentials,
    save_selected_service,
    save_service_alias,
)
from chkit_plugin_obsessiondb.credentials import DEFAULT_BASE_URL
from chkit_plugin_obsessiondb.onboarding import ConnectChoice


@pytest.fixture
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Pin XDG_CONFIG_HOME to a tmp dir so credentials don't touch the real ~/.config."""
    cfg_dir = tmp_path / "xdg"
    cfg_dir.mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_dir))
    monkeypatch.delenv("OBSESSIONDB_API_URL", raising=False)
    return cfg_dir


# ---------- plugin factory ----------


def test_obsessiondb_returns_valid_plugin() -> None:
    plugin = obsessiondb()
    assert plugin.manifest == ChxPluginManifest(name="obsessiondb", api_version=1)
    assert plugin.hooks is not None
    assert hasattr(plugin.hooks, "on_schema_loaded")


def test_create_obsessiondb_plugin_can_be_loaded_by_runtime() -> None:
    runtime = load_plugin_runtime([create_obsessiondb_plugin()])
    assert [e.plugin.manifest.name for e in runtime.plugins] == ["obsessiondb"]


# ---------- hook integration ----------


def _config(url: str | None = None) -> ChxResolvedConfig:
    ch = (
        ChxResolvedClickHouseConfig(
            url=url, username="default", password="", database="default", secure=False
        )
        if url is not None
        else None
    )
    return ChxResolvedConfig(
        schema_=["./schema.py"],
        out_dir="./chkit",
        migrations_dir="./chkit/migrations",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
        clickhouse=ch,
    )


def test_on_schema_loaded_strips_shared_engine_for_local_target(
    capsys: pytest.CaptureFixture[str],
) -> None:
    runtime = load_plugin_runtime([obsessiondb()])
    t = table(
        database="db",
        name="events",
        engine="SharedMergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
    )
    out = runtime.run_on_schema_loaded(
        ChxOnSchemaLoadedContext(
            command="generate",
            config=_config(url="http://localhost:8123"),
            table_scope=TableScope(enabled=False),
            flags={},
            definitions=[t],
            json_mode=False,
        )
    )
    assert len(out) == 1
    assert out[0].engine == "MergeTree"
    assert "Rewrote 1 Shared engine" in capsys.readouterr().out


def test_on_schema_loaded_keeps_shared_engine_on_obsessiondb(
    capsys: pytest.CaptureFixture[str],
) -> None:
    runtime = load_plugin_runtime([obsessiondb()])
    t = table(
        database="db",
        name="events",
        engine="SharedMergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
    )
    out = runtime.run_on_schema_loaded(
        ChxOnSchemaLoadedContext(
            command="generate",
            config=_config(url="https://x.obsessiondb.com"),
            table_scope=TableScope(enabled=False),
            flags={},
            definitions=[t],
            json_mode=False,
        )
    )
    assert out[0].engine == "SharedMergeTree"
    assert "Rewrote" not in capsys.readouterr().out


def test_on_schema_loaded_silent_under_json_mode(
    capsys: pytest.CaptureFixture[str],
) -> None:
    runtime = load_plugin_runtime([obsessiondb()])
    t = table(
        database="db",
        name="events",
        engine="SharedMergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
    )
    out = runtime.run_on_schema_loaded(
        ChxOnSchemaLoadedContext(
            command="generate",
            config=_config(url="http://localhost:8123"),
            table_scope=TableScope(enabled=False),
            flags={},
            definitions=[t],
            json_mode=True,
        )
    )
    assert out[0].engine == "MergeTree"
    assert "Rewrote" not in capsys.readouterr().out


# ---------- credentials ----------


def test_credentials_path_uses_xdg(isolated_home: Path) -> None:
    path = get_credentials_path()
    assert path == isolated_home / "chkit" / "credentials.json"


def test_save_and_load_credentials_round_trip(isolated_home: Path) -> None:
    creds = Credentials(
        access_token="tok-abc", base_url="https://my-tenant.obsessiondb.com"
    )
    save_credentials(creds)
    loaded = load_credentials()
    assert loaded is not None
    assert loaded.access_token == "tok-abc"
    assert loaded.base_url == "https://my-tenant.obsessiondb.com"


def test_load_credentials_returns_none_when_missing(isolated_home: Path) -> None:
    assert load_credentials() is None


def test_load_credentials_returns_none_for_invalid_json(isolated_home: Path) -> None:
    path = get_credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("not valid json", encoding="utf-8")
    assert load_credentials() is None


def test_load_credentials_returns_none_when_token_missing(
    isolated_home: Path,
) -> None:
    path = get_credentials_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"base_url": "x"}), encoding="utf-8")
    assert load_credentials() is None


def test_resolve_base_url_prefers_env(
    isolated_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OBSESSIONDB_API_URL", "https://override.example.com")
    assert resolve_base_url("https://from-creds") == "https://override.example.com"


def test_resolve_base_url_uses_stored_when_no_env() -> None:
    assert (
        resolve_base_url("https://from-creds.example.com")
        == "https://from-creds.example.com"
    )


def test_resolve_base_url_falls_back_to_default(isolated_home: Path) -> None:
    assert resolve_base_url(None) == DEFAULT_BASE_URL


# ---------- service storage ----------


def test_save_and_load_selected_service_for_project(tmp_path: Path) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    config_path.write_text("# config\n", encoding="utf-8")
    service = SelectedService(
        organization_id="org-1",
        organization_slug="my-org",
        service_id="svc-1",
        service_name="prod",
        service_slug="prod-eu",
    )
    save_selected_service(config_path, service)
    loaded = load_selected_service(config_path)
    assert loaded == service


def test_load_selected_service_returns_none_when_missing(tmp_path: Path) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    config_path.write_text("# config\n", encoding="utf-8")
    assert load_selected_service(config_path) is None


def test_save_and_load_service_alias(isolated_home: Path) -> None:
    service = SelectedService(
        organization_id="o", organization_slug="o",
        service_id="s", service_name="prod", service_slug="prod",
    )
    save_service_alias("prod", service)
    aliases = load_service_aliases()
    assert "prod" in aliases.aliases
    assert aliases.aliases["prod"].service_slug == "prod"


def test_load_service_aliases_empty_when_no_file(isolated_home: Path) -> None:
    aliases = load_service_aliases()
    assert aliases.aliases == {}


# ---------- onboarding stub ----------


def test_run_onboarding_prints_runbook_when_no_creds(
    isolated_home: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    run_onboarding(config_path=config_path)
    out = capsys.readouterr().out
    # Non-TTY + no choice → runbook + next-steps
    assert "Free ObsessionDB dev instance" in out
    assert "chkit plugin obsessiondb signup" in out
    assert "Next steps" in out


def test_run_onboarding_prints_authenticated_runbook_when_creds_exist(
    isolated_home: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    save_credentials(
        Credentials(access_token="tok", base_url="https://x.obsessiondb.com")
    )
    config_path = tmp_path / "clickhouse.config.py"
    run_onboarding(config_path=config_path)
    out = capsys.readouterr().out
    # Non-TTY path is independent of credentials state — it prints the full runbook.
    assert "Existing ObsessionDB account" in out
    assert "Next steps" in out


def test_run_onboarding_later_choice_skips_runbook(
    isolated_home: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    config_path = tmp_path / "clickhouse.config.py"
    run_onboarding(config_path=config_path, connect=ConnectChoice.later)
    out = capsys.readouterr().out
    # An explicit "later" choice goes straight to next-steps, no runbook noise.
    assert "Next steps" in out
    assert "Free ObsessionDB dev instance" not in out


# ---------- init dispatch (chkit init now picks us up) ----------


def test_chkit_init_dispatches_to_obsessiondb_onboarding(
    isolated_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """End-to-end: chkit init -> import chkit_plugin_obsessiondb -> run_onboarding()."""
    monkeypatch.chdir(tmp_path)
    runner = CliRunner()
    result = runner.invoke(app, ["init"])
    assert result.exit_code == 0
    # The Phase 4 wizard fires from `chkit init` — in non-TTY mode it prints the
    # connect runbook + the next-steps block.
    assert "Free ObsessionDB dev instance" in result.output
    assert "Next steps" in result.output
