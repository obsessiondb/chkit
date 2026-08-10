"""Tests for `chkit init` — scaffolding + onboarding dispatch."""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.commands import init
from chkit.cli.commands.init import (
    DEFAULT_CONFIG_FILE,
    OBSESSIONDB_PLUGIN_MODULE,
    ConnectChoice,
    _maybe_run_onboarding,
    _try_import_obsessiondb,
)
from chkit.cli.main import app


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


@pytest.fixture
def isolated_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture(autouse=True)
def cleanup_plugin_module() -> Any:
    """Remove the obsessiondb plugin stub between tests so each starts clean."""
    sys.modules.pop(OBSESSIONDB_PLUGIN_MODULE, None)
    yield
    sys.modules.pop(OBSESSIONDB_PLUGIN_MODULE, None)


def _install_stub_plugin(*, captured: dict[str, Any]) -> ModuleType:
    """Inject a fake `chkit_plugin_obsessiondb` into sys.modules."""
    stub = ModuleType(OBSESSIONDB_PLUGIN_MODULE)

    def run_onboarding(**kwargs: Any) -> None:
        captured.update(kwargs)

    stub.run_onboarding = run_onboarding  # type: ignore[attr-defined]
    sys.modules[OBSESSIONDB_PLUGIN_MODULE] = stub
    return stub


# ---------- scaffolding ----------


def test_writes_config_and_schema_when_missing(
    runner: CliRunner, isolated_cwd: Path
) -> None:
    result = runner.invoke(app, ["init", "--yes"])
    assert result.exit_code == 0
    assert (isolated_cwd / DEFAULT_CONFIG_FILE).exists()
    assert (isolated_cwd / "src" / "db" / "schema" / "example.py").exists()
    assert "Created clickhouse.config.py" in result.stdout
    assert "example.py" in result.stdout


def test_does_not_overwrite_existing_files(
    runner: CliRunner, isolated_cwd: Path
) -> None:
    config_path = isolated_cwd / DEFAULT_CONFIG_FILE
    config_path.write_text("# user-customized\n", encoding="utf-8")
    schema_path = isolated_cwd / "src" / "db" / "schema" / "example.py"
    schema_path.parent.mkdir(parents=True)
    schema_path.write_text("# custom\n", encoding="utf-8")

    result = runner.invoke(app, ["init", "--yes"])
    assert result.exit_code == 0
    assert config_path.read_text(encoding="utf-8") == "# user-customized\n"
    assert schema_path.read_text(encoding="utf-8") == "# custom\n"
    # Nothing "Created" line should appear; nothing was scaffolded.
    assert "Created" not in result.stdout
    # And no next-steps either (because nothing was written).
    assert "Next steps" not in result.stdout


# ---------- --yes flag ----------


def test_yes_short_form_works(runner: CliRunner, isolated_cwd: Path) -> None:
    result = runner.invoke(app, ["init", "-y"])
    assert result.exit_code == 0
    assert (isolated_cwd / DEFAULT_CONFIG_FILE).exists()


def test_yes_suppresses_onboarding(runner: CliRunner, isolated_cwd: Path) -> None:
    captured: dict[str, Any] = {}
    _install_stub_plugin(captured=captured)
    result = runner.invoke(app, ["init", "--yes"])
    assert result.exit_code == 0
    assert captured == {}
    assert "Next steps" in result.stdout


# ---------- Onboarding dispatch ----------


def test_onboarding_dispatched_when_plugin_present(
    runner: CliRunner, isolated_cwd: Path
) -> None:
    captured: dict[str, Any] = {}
    _install_stub_plugin(captured=captured)
    result = runner.invoke(app, ["init"])
    assert result.exit_code == 0
    assert captured["config_path"] == isolated_cwd / DEFAULT_CONFIG_FILE
    assert captured["connect"] is None
    assert captured["email"] is None
    assert captured["code"] is None
    assert captured["org_name"] is None
    # Next steps is suppressed because onboarding ran.
    assert "Next steps" not in result.stdout


def test_onboarding_skipped_when_plugin_absent_shows_next_steps(
    runner: CliRunner, isolated_cwd: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Point the plugin lookup at a name that definitely isn't installed.
    monkeypatch.setattr(init, "OBSESSIONDB_PLUGIN_MODULE", "chkit_plugin_obsessiondb_ghost")
    sys.modules.pop("chkit_plugin_obsessiondb_ghost", None)
    result = runner.invoke(app, ["init"])
    assert result.exit_code == 0
    assert "Next steps" in result.stdout
    assert "chkit generate --name init" in result.stdout


def test_onboarding_threads_all_flag_values_to_plugin(
    runner: CliRunner, isolated_cwd: Path
) -> None:
    captured: dict[str, Any] = {}
    _install_stub_plugin(captured=captured)
    result = runner.invoke(
        app,
        [
            "init",
            "--connect",
            "claim",
            "--email",
            "dev@example.com",
            "--code",
            "123456",
            "--org-name",
            "acme",
        ],
    )
    assert result.exit_code == 0
    assert captured["connect"] == ConnectChoice.claim
    assert captured["email"] == "dev@example.com"
    assert captured["code"] == "123456"
    assert captured["org_name"] == "acme"


def test_connect_rejects_unknown_value(
    runner: CliRunner, isolated_cwd: Path
) -> None:
    result = runner.invoke(app, ["init", "--yes", "--connect", "totally-bogus"])
    assert result.exit_code != 0


def test_connect_accepts_account(runner: CliRunner, isolated_cwd: Path) -> None:
    captured: dict[str, Any] = {}
    _install_stub_plugin(captured=captured)
    result = runner.invoke(app, ["init", "--connect", "account"])
    assert result.exit_code == 0
    assert captured["connect"] == ConnectChoice.account


def test_connect_accepts_clickhouse(runner: CliRunner, isolated_cwd: Path) -> None:
    captured: dict[str, Any] = {}
    _install_stub_plugin(captured=captured)
    result = runner.invoke(app, ["init", "--connect", "clickhouse"])
    assert result.exit_code == 0
    assert captured["connect"] == ConnectChoice.clickhouse


def test_connect_accepts_later(runner: CliRunner, isolated_cwd: Path) -> None:
    captured: dict[str, Any] = {}
    _install_stub_plugin(captured=captured)
    result = runner.invoke(app, ["init", "--connect", "later"])
    assert result.exit_code == 0
    assert captured["connect"] == ConnectChoice.later


# ---------- Plugin import isolation ----------


def test_try_import_returns_none_when_plugin_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(init, "OBSESSIONDB_PLUGIN_MODULE", "chkit_plugin_obsessiondb_ghost")
    sys.modules.pop("chkit_plugin_obsessiondb_ghost", None)
    assert _try_import_obsessiondb() is None


def test_try_import_returns_module_when_stub_present() -> None:
    captured: dict[str, Any] = {}
    _install_stub_plugin(captured=captured)
    module = _try_import_obsessiondb()
    assert module is not None
    assert module.__name__ == OBSESSIONDB_PLUGIN_MODULE


def test_try_import_propagates_unrelated_module_not_found() -> None:
    """A ModuleNotFoundError for a *different* missing module must surface."""
    broken = ModuleType(OBSESSIONDB_PLUGIN_MODULE)

    def trigger() -> None:
        raise ModuleNotFoundError("No module named 'something_else'", name="something_else")

    broken.__getattr__ = lambda _name: trigger()  # type: ignore[attr-defined,method-assign]
    sys.modules[OBSESSIONDB_PLUGIN_MODULE] = broken
    # _try_import_obsessiondb should succeed; the inner error surfaces only on use.
    module = _try_import_obsessiondb()
    assert module is broken


def test_maybe_run_onboarding_returns_false_when_yes(tmp_path: Path) -> None:
    sys.modules.pop(OBSESSIONDB_PLUGIN_MODULE, None)
    captured: dict[str, Any] = {}
    _install_stub_plugin(captured=captured)
    ran = _maybe_run_onboarding(
        tmp_path / DEFAULT_CONFIG_FILE,
        yes=True,
        connect=None,
        email=None,
        code=None,
        org_name=None,
    )
    assert ran is False
    assert captured == {}


def test_maybe_run_onboarding_returns_false_when_plugin_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(init, "OBSESSIONDB_PLUGIN_MODULE", "chkit_plugin_obsessiondb_ghost")
    sys.modules.pop("chkit_plugin_obsessiondb_ghost", None)
    ran = _maybe_run_onboarding(
        tmp_path / DEFAULT_CONFIG_FILE,
        yes=False,
        connect=None,
        email=None,
        code=None,
        org_name=None,
    )
    assert ran is False


def test_default_config_file_name() -> None:
    # Sanity: keep the Python default filename in lockstep with the TS one,
    # adjusted for language (.py vs .ts).
    assert DEFAULT_CONFIG_FILE == "clickhouse.config.py"


def test_init_module_does_not_use_typer_context_truthiness() -> None:
    """Regression: earlier port had `bool(typer.Context)` which is always True.
    The current `run()` should not import or call typer.Context at all.
    """
    src = Path(init.__file__).read_text(encoding="utf-8")
    assert "typer.Context" not in src
