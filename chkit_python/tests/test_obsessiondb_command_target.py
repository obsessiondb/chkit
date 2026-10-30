"""Every command that talks to ClickHouse runs through the selected ObsessionDB
service, before a `clickhouse` block, as `check` and the TS CLI do (#340)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit_plugin_obsessiondb import (
    Credentials,
    SelectedService,
    plugin,
    remote_executor,
    save_credentials,
    save_selected_service,
)
from chkit_plugin_obsessiondb.service_api import Service
from chkit_plugin_obsessiondb.workbench_api import WorkbenchExecuteResult

BASE = "https://api.test.obsessiondb.com"
SLUG = "benchmarks"
# Nothing listens here, so a command that connects to the `clickhouse` block fails.
UNREACHABLE_BLOCK = '{"url": "http://127.0.0.1:9", "username": "default", "password": ""}'

COMMANDS = [
    pytest.param(["status", "--json"], id="status"),
    pytest.param(["migrate", "--json"], id="migrate"),
    pytest.param(["drift", "--live", "--json"], id="drift"),
    pytest.param(["query", "SELECT 1", "--json"], id="query"),
    pytest.param(["pull", "--dryrun", "--json"], id="pull"),
]


@pytest.fixture
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    cfg_dir = tmp_path / "xdg"
    cfg_dir.mkdir()
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_dir))
    monkeypatch.delenv("OBSESSIONDB_API_URL", raising=False)
    return cfg_dir


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Every (service slug, SQL) sent through the workbench API."""
    sent: list[tuple[str, str]] = []

    def fake_execute(
        creds: Credentials, *, service_slug: str, query: str, **_kwargs: Any
    ) -> WorkbenchExecuteResult:
        assert creds.base_url == BASE
        sent.append((service_slug, query))
        return WorkbenchExecuteResult(data=[], meta=[], rows=0)

    monkeypatch.setattr(remote_executor, "workbench_query_execute", fake_execute)
    return sent


def _project(
    root: Path, *, clickhouse_block: str | None, selected: str | None = SLUG
) -> Path:
    """A logged-in project with a selected service and an empty snapshot."""
    root.mkdir()
    (root / "schema.py").write_text("", encoding="utf-8")
    clickhouse = f", clickhouse={clickhouse_block}" if clickhouse_block else ""
    config_path = root / "clickhouse.config.py"
    config_path.write_text(
        "from chkit import ChxUserConfig\n"
        "from chkit_plugin_obsessiondb import obsessiondb\n"
        'config = ChxUserConfig(schema=["./schema.py"], '
        f"plugins=[obsessiondb()]{clickhouse})\n",
        encoding="utf-8",
    )
    meta_dir = root / "chkit" / "meta"
    meta_dir.mkdir(parents=True)
    (meta_dir / "snapshot.json").write_text(
        json.dumps({"version": 1, "generatedAt": "", "definitions": []}),
        encoding="utf-8",
    )
    save_credentials(Credentials(access_token="tok", base_url=BASE))
    if selected is not None:
        save_selected_service(
            config_path, SelectedService(service_slug=selected, service_name=selected)
        )
    return config_path


@pytest.mark.usefixtures("isolated_home")
@pytest.mark.parametrize("args", COMMANDS)
@pytest.mark.parametrize(
    "clickhouse_block",
    [pytest.param(None, id="no-block"), pytest.param(UNREACHABLE_BLOCK, id="block")],
)
def test_command_runs_through_the_selected_service(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    calls: list[tuple[str, str]],
    args: list[str],
    clickhouse_block: str | None,
) -> None:
    config_path = _project(tmp_path / "project", clickhouse_block=clickhouse_block)
    monkeypatch.chdir(config_path.parent)

    result = CliRunner().invoke(app, [*args, "--config", str(config_path)])

    assert result.exit_code == 0, result.output
    assert calls
    assert {slug for slug, _ in calls} == {SLUG}


@pytest.mark.usefixtures("isolated_home")
@pytest.mark.parametrize("args", COMMANDS)
def test_command_names_the_selected_service_in_text_mode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    calls: list[tuple[str, str]],
    args: list[str],
) -> None:
    config_path = _project(tmp_path / "project", clickhouse_block=None)
    monkeypatch.chdir(config_path.parent)
    text_args = [arg for arg in args if arg != "--json"]

    result = CliRunner().invoke(app, [*text_args, "--config", str(config_path)])

    assert result.exit_code == 0, result.output
    assert result.output.startswith(f'obsessiondb: using service "{SLUG}"\n')
    assert calls


@pytest.mark.usefixtures("isolated_home")
def test_migrate_through_the_service_records_applied_at_without_a_zone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, calls: list[tuple[str, str]]
) -> None:
    # The ObsessionDB API does not parse best effort, so a `Z` suffix on
    # applied_at fails the journal INSERT into DateTime64(3, 'UTC').
    config_path = _project(tmp_path / "project", clickhouse_block=None)
    migrations_dir = config_path.parent / "chkit" / "migrations"
    migrations_dir.mkdir(parents=True)
    (migrations_dir / "20260101000000_select.sql").write_text("SELECT 1;\n", encoding="utf-8")
    monkeypatch.chdir(config_path.parent)

    result = CliRunner().invoke(
        app, ["migrate", "--apply", "--json", "--config", str(config_path)]
    )

    assert result.exit_code == 0, result.output
    inserts = [sql for _, sql in calls if sql.startswith("INSERT INTO _chkit_migrations")]
    assert inserts
    applied_at = re.search(r"VALUES \('[^']*', '([^']*)'", inserts[-1])
    assert applied_at is not None
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}", applied_at.group(1))


@pytest.mark.usefixtures("isolated_home")
@pytest.mark.parametrize(
    "args", [*COMMANDS, pytest.param(["check", "--json"], id="check")]
)
def test_command_without_a_target_exits_1_with_the_error_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, args: list[str]
) -> None:
    # No `clickhouse` block and no selected service is a runtime error, as in
    # TS: the message on stderr, the envelope on stdout, exit 1 (#354).
    root = tmp_path / "project"
    meta_dir = root / "chkit" / "meta"
    meta_dir.mkdir(parents=True)
    (root / "schema.py").write_text("", encoding="utf-8")
    (meta_dir / "snapshot.json").write_text(
        json.dumps({"version": 1, "generatedAt": "", "definitions": []}),
        encoding="utf-8",
    )
    config_path = root / "clickhouse.config.py"
    config_path.write_text(
        "from chkit import ChxUserConfig\n"
        'config = ChxUserConfig(schema=["./schema.py"])\n',
        encoding="utf-8",
    )
    monkeypatch.chdir(root)

    result = CliRunner().invoke(app, [*args, "--config", str(config_path)])

    assert result.exit_code == 1, result.output
    envelope = json.loads(result.stdout)
    assert envelope["command"] == args[0]
    assert envelope["ok"] is False
    assert envelope["error"]["code"] == "error"
    assert "select an ObsessionDB service" in envelope["error"]["message"]
    assert envelope["error"]["message"] in result.stderr
    assert "Usage:" not in result.stderr


# ---------- --service <name> overrides the selected service (TS getContext) ----------

OVERRIDE_NAME = "Analytics"
OVERRIDE_SLUG = "analytics-eu"


@pytest.fixture
def listed_services(monkeypatch: pytest.MonkeyPatch) -> None:
    """The org has one service, `Analytics`, besides the selected one."""

    def fake_list_services(creds: Credentials) -> list[Service]:
        assert creds.base_url == BASE
        return [
            Service.model_validate(
                {
                    "id": f"id-{OVERRIDE_SLUG}",
                    "slug": OVERRIDE_SLUG,
                    "name": OVERRIDE_NAME,
                    "status": "running",
                    "tier": 1,
                    "nodes": 1,
                    "desiredStatus": "running",
                    "desiredTier": 1,
                    "desiredNodes": 1,
                    "createdAt": "2026-01-01T00:00:00Z",
                    "managed": True,
                }
            )
        ]

    monkeypatch.setattr(plugin, "list_services", fake_list_services)


@pytest.mark.usefixtures("isolated_home", "listed_services")
@pytest.mark.parametrize("args", COMMANDS)
@pytest.mark.parametrize(
    "selected",
    [pytest.param(None, id="none-selected"), pytest.param(SLUG, id="other-selected")],
)
def test_service_flag_runs_the_command_through_the_named_service(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    calls: list[tuple[str, str]],
    args: list[str],
    selected: str | None,
) -> None:
    config_path = _project(
        tmp_path / "project", clickhouse_block=UNREACHABLE_BLOCK, selected=selected
    )
    monkeypatch.chdir(config_path.parent)

    result = CliRunner().invoke(
        app, [*args, "--service", OVERRIDE_NAME, "--config", str(config_path)]
    )

    assert result.exit_code == 0, result.output
    assert calls
    assert {slug for slug, _ in calls} == {OVERRIDE_SLUG}


@pytest.mark.usefixtures("isolated_home", "listed_services")
@pytest.mark.parametrize("args", [*COMMANDS, pytest.param(["generate"], id="generate")])
def test_service_flag_names_the_named_service_in_text_mode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    calls: list[tuple[str, str]],
    args: list[str],
) -> None:
    config_path = _project(tmp_path / "project", clickhouse_block=None, selected=None)
    monkeypatch.chdir(config_path.parent)
    text_args = [arg for arg in args if arg != "--json"]

    result = CliRunner().invoke(
        app, [*text_args, "--service", OVERRIDE_NAME, "--config", str(config_path)]
    )

    assert result.exit_code == 0, result.output
    assert result.output.startswith(f'obsessiondb: using service "{OVERRIDE_NAME}"\n')


@pytest.mark.usefixtures("isolated_home", "listed_services")
def test_service_flag_resolves_an_alias(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, calls: list[tuple[str, str]]
) -> None:
    config_path = _project(tmp_path / "project", clickhouse_block=None, selected=None)
    # The project file exactly as the TS CLI writes it (#366).
    service_file = config_path.parent / ".chkit" / "obsessiondb.json"
    service_file.parent.mkdir()
    service_file.write_text(
        json.dumps(
            {
                "service_slug": SLUG,
                "service_name": SLUG,
                "aliases": {
                    "prod": {"service_slug": "prod-eu", "service_name": "Production"}
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(config_path.parent)

    result = CliRunner().invoke(
        app, ["status", "--service", "prod", "--config", str(config_path)]
    )

    assert result.exit_code == 0, result.output
    assert result.output.startswith('obsessiondb: using service "Production"\n')
    assert {slug for slug, _ in calls} == {"prod-eu"}


@pytest.mark.usefixtures("isolated_home", "listed_services")
@pytest.mark.parametrize(
    "args", [*COMMANDS, pytest.param(["generate", "--json"], id="generate")]
)
def test_service_flag_with_an_unknown_name_fails_and_lists_the_choices(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    calls: list[tuple[str, str]],
    args: list[str],
) -> None:
    config_path = _project(tmp_path / "project", clickhouse_block=None)
    monkeypatch.chdir(config_path.parent)

    result = CliRunner().invoke(
        app, [*args, "--service", "nope", "--config", str(config_path)]
    )

    assert result.exit_code == 1, result.output
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is False
    assert envelope["error"]["message"] == (
        'Plugin "obsessiondb" failed in getContext: obsessiondb: service "nope" '
        f"not found. Available services: {OVERRIDE_NAME}. Available aliases: <none>"
    )
    assert envelope["error"]["message"] in result.stderr
    assert calls == []
