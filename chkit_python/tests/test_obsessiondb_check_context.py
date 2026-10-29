"""`chkit check` without a `clickhouse` block runs through the ObsessionDB
remote executor once a service is selected (#325)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.cli.plugin_runtime import load_plugin_runtime, null_plugin_context
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit.plugins import ChxGetContextInput
from chkit_plugin_obsessiondb import (
    Credentials,
    RemoteClickHouseClient,
    SelectedService,
    obsessiondb,
    remote_executor,
    save_credentials,
    save_selected_service,
)
from chkit_plugin_obsessiondb.workbench_api import WorkbenchExecuteResult

BASE = "https://api.test.obsessiondb.com"
SLUG = "benchmarks"


@pytest.fixture
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg_dir = tmp_path / "xdg"
    cfg_dir.mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_dir))
    monkeypatch.delenv("OBSESSIONDB_API_URL", raising=False)
    return cfg_dir


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """A project with the obsessiondb plugin and no `clickhouse` block."""
    root = tmp_path / "project"
    root.mkdir()
    (root / "schema.py").write_text("", encoding="utf-8")
    (root / "clickhouse.config.py").write_text(
        "from chkit import ChxUserConfig\n"
        "from chkit_plugin_obsessiondb import obsessiondb\n"
        'config = ChxUserConfig(schema=["./schema.py"], plugins=[obsessiondb()])\n',
        encoding="utf-8",
    )
    return root


def _config() -> ChxResolvedConfig:
    return ChxResolvedConfig(
        schema_=["./schema.py"],
        out_dir="./chkit",
        migrations_dir="./chkit/migrations",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )


def _resolve(config_path: Path) -> Any:
    runtime = load_plugin_runtime([obsessiondb()])
    return runtime.resolve_context(
        ChxGetContextInput(
            config=_config(),
            config_path=str(config_path),
            command="check",
            flags={},
            defaults=null_plugin_context(),
        )
    )


def _log_in_and_select(config_path: Path) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    save_selected_service(
        config_path, SelectedService(service_slug=SLUG, service_name=SLUG)
    )


def test_get_context_defers_without_a_session(
    isolated_home: Path, project: Path
) -> None:
    save_selected_service(
        project / "clickhouse.config.py",
        SelectedService(service_slug=SLUG, service_name=SLUG),
    )
    assert _resolve(project / "clickhouse.config.py") is None


def test_get_context_defers_without_a_selected_service(
    isolated_home: Path, project: Path
) -> None:
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    assert _resolve(project / "clickhouse.config.py") is None


def test_get_context_returns_the_remote_executor_for_the_selected_service(
    isolated_home: Path, project: Path
) -> None:
    _log_in_and_select(project / "clickhouse.config.py")
    ctx = _resolve(project / "clickhouse.config.py")
    assert ctx is not None
    assert ctx.has_executor is True
    assert isinstance(ctx.executor, RemoteClickHouseClient)
    assert ctx.executor._service_slug == SLUG


def test_check_without_clickhouse_block_runs_through_the_selected_service(
    isolated_home: Path, project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = project / "clickhouse.config.py"
    _log_in_and_select(config_path)
    calls: list[tuple[str, str]] = []

    def fake_execute(
        creds: Credentials, *, service_slug: str, query: str, **_kwargs: Any
    ) -> WorkbenchExecuteResult:
        assert creds.base_url == BASE
        calls.append((service_slug, query))
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    monkeypatch.setattr(remote_executor, "workbench_query_execute", fake_execute)
    monkeypatch.chdir(project)
    result = CliRunner().invoke(
        app, ["check", "--config", str(config_path), "--json"]
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["ok"] is True
    assert calls
    assert {slug for slug, _ in calls} == {SLUG}
    assert any("_chkit_migrations" in query for _, query in calls)


def test_check_names_the_selected_service_in_text_mode(
    isolated_home: Path, project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = project / "clickhouse.config.py"
    _log_in_and_select(config_path)
    monkeypatch.setattr(
        remote_executor,
        "workbench_query_execute",
        lambda *_args, **_kwargs: WorkbenchExecuteResult(data=[], meta=[], rows=0),
    )
    monkeypatch.chdir(project)
    result = CliRunner().invoke(app, ["check", "--config", str(config_path)])

    assert result.exit_code == 0, result.output
    assert result.output.startswith(f'obsessiondb: using service "{SLUG}"\n')


def test_check_without_clickhouse_block_or_service_says_what_is_missing(
    isolated_home: Path, project: Path
) -> None:
    result = CliRunner().invoke(
        app, ["check", "--config", str(project / "clickhouse.config.py")]
    )

    assert result.exit_code == 2
    assert "select an ObsessionDB service" in result.output
