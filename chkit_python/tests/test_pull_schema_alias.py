"""``chkit pull schema`` is ``chkit pull`` (#771).

In TS, ``pull`` is a plugin whose one command is ``schema``: ``chkit pull``
runs it, and so do ``chkit pull schema`` and ``chkit plugin pull schema``.
chkit-py's ``pull`` is a built-in command that takes a leading ``schema`` the
same way: only the first argument, and only when it is ``schema``. Any other
argument is the usual stray-argument error.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app
from tests.e2e_testkit import create_prefix, format_test_diagnostic, resolve_live_env


@pytest.fixture(autouse=True)
def _fresh_emit_flag() -> Iterator[None]:
    _reset_for_testing()
    yield
    _reset_for_testing()


@pytest.fixture
def empty_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def project(empty_dir: Path) -> Path:
    env = resolve_live_env()
    clickhouse = json.dumps(
        {
            "url": env.clickhouse_url,
            "username": env.clickhouse_user,
            "password": env.clickhouse_password,
            "database": env.clickhouse_database,
        }
    )
    (empty_dir / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\n"
        "config = define_config({\n"
        '    "schema": "./schema.py",\n'
        '    "outDir": "./chkit",\n'
        '    "migrationsDir": "./chkit/migrations",\n'
        '    "metaDir": "./chkit/meta",\n'
        f'    "clickhouse": {clickhouse},\n'
        "})\n"
    )
    (empty_dir / "schema.py").write_text("")
    return empty_dir


def _run(*args: str) -> Any:
    _reset_for_testing()
    return CliRunner().invoke(app, list(args))


def _outcome(result: Any) -> tuple[int, str, str]:
    return (result.exit_code, result.stdout, result.stderr)


@pytest.mark.parametrize(
    "args",
    [
        [],
        ["--json"],
        ["--dryrun"],
        ["--dryrun", "--json"],
        ["-o", "out.py", "--dryrun"],
    ],
)
def test_pull_schema_outside_a_project_is_pull(empty_dir: Path, args: list[str]) -> None:
    pull = _run("pull", *args)
    assert pull.exit_code == 1
    assert "Config not found at " in pull.stderr
    assert _outcome(_run("pull", "schema", *args)) == _outcome(pull)
    assert _outcome(_run("pull", *args, "schema")) == _outcome(pull)
    assert _outcome(_run("pull", *args, "--", "schema")) == _outcome(pull)
    assert sorted(path.name for path in empty_dir.iterdir()) == []


STRAY_CASES = [
    (["pull", "foo"], "foo"),
    (["pull", "schema", "foo"], "foo"),
    (["pull", "foo", "schema"], "foo schema"),
    (["pull", "schema", "schema"], "schema"),
    (["pull", "--dryrun", "schema", "foo"], "foo"),
    (["pull", "schema", "--", "foo"], "foo"),
    (["pull", "--", "--json"], "--json"),
]


@pytest.mark.parametrize(("args", "extra"), STRAY_CASES)
def test_any_other_argument_is_a_stray_argument_outside_a_project(
    empty_dir: Path, args: list[str], extra: str
) -> None:
    message = f"Got unexpected extra argument(s) ({extra})"
    assert _outcome(_run(*args)) == (1, "", f"{message}\n")
    if "--" in args:
        return
    as_json = _run(*args, "--json")
    assert (as_json.exit_code, as_json.stderr) == (1, f"{message}\n")
    assert json.loads(as_json.stdout) == {
        "command": "pull",
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "usage", "message": message},
    }


@pytest.mark.parametrize(("args", "extra"), STRAY_CASES)
def test_any_other_argument_is_a_stray_argument_in_a_project(
    project: Path, args: list[str], extra: str
) -> None:
    assert _outcome(_run(*args)) == (1, "", f"Got unexpected extra argument(s) ({extra})\n")
    assert sorted(path.name for path in project.iterdir()) == ["clickhouse.config.py", "schema.py"]


def test_pull_schema_in_a_project_is_pull(project: Path) -> None:
    # A database that does not exist: pull reads an empty schema.
    args = ["--database", f"{create_prefix('pull_alias_py')}db", "--dryrun"]
    for extra in [[], ["--json"]]:
        pull = _run("pull", *args, *extra)
        assert pull.exit_code == 0, format_test_diagnostic("chkit pull", pull)
        for alias in [
            ["pull", "schema", *args, *extra],
            ["pull", *args, "schema", *extra],
            ["pull", *args, *extra, "--", "schema"],
            ["plugin", "pull", "schema", *args, *extra],
        ]:
            assert _outcome(_run(*alias)) == _outcome(pull), alias
    payload = json.loads(_run("pull", "schema", *args, "--json").stdout)
    assert (payload["ok"], payload["command"], payload["dryrun"]) == (True, "schema", True)


def test_pull_schema_writes_the_file_as_pull_does(project: Path) -> None:
    args = ["--database", f"{create_prefix('pull_alias_py')}db"]
    result = _run("pull", "schema", *args, "-o", "pulled.py", "--json")
    assert result.exit_code == 0, format_test_diagnostic("chkit pull schema", result)
    assert json.loads(result.stdout)["outFile"] == str(project.resolve() / "pulled.py")
    assert (project / "pulled.py").is_file()
    # `schema` is the value of -o here, not the command name.
    named = _run("pull", *args, "-o", "schema", "--json")
    assert named.exit_code == 0, format_test_diagnostic("chkit pull -o schema", named)
    assert (project / "schema").is_file()


def test_plugin_pull_is_the_pull_plugin_in_a_project(project: Path) -> None:
    description = "Pull live ClickHouse table schema and write chkit schema file"
    assert _outcome(_run("plugin", "pull")) == (
        0,
        f'Plugin commands for "pull":\n- schema: {description}\n',
        "",
    )
    listed = _run("plugin", "pull", "--json")
    assert listed.exit_code == 0
    assert json.loads(listed.stdout) == {
        "command": "plugin",
        "schemaVersion": 1,
        "plugin": "pull",
        "commands": [{"name": "schema", "description": description}],
    }

    unknown = 'Unknown pull command "foo". Available: schema.'
    assert _outcome(_run("plugin", "pull", "foo")) == (1, "", f"{unknown}\n")
    as_json = _run("plugin", "pull", "foo", "--json")
    assert as_json.exit_code == 1
    assert json.loads(as_json.stdout) == {
        "command": "plugin",
        "schemaVersion": 1,
        "ok": False,
        "error": unknown,
    }

    stray = "Got unexpected extra argument(s) (foo)"
    assert _outcome(_run("plugin", "pull", "schema", "foo")) == (1, "", f"{stray}\n")
    stray_json = _run("plugin", "pull", "schema", "foo", "--json")
    assert (stray_json.exit_code, stray_json.stderr) == (1, f"{stray}\n")
    assert json.loads(stray_json.stdout) == {
        "command": "plugin",
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "usage", "message": stray},
    }
    assert not (project / "src").exists()
