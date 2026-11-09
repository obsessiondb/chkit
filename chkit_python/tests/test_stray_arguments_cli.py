"""A stray argument fails as in the TS CLI (#612).

``generate``, ``migrate``, ``status``, ``drift``, ``check`` and ``init`` take
no arguments other than flags. One of them gets click's message, on stderr,
with exit code 1 and, under ``--json``, a ``usage`` error envelope, as an
unknown flag does (``parseCommandArgs`` in
``packages/cli/src/runtime/command-dispatch.ts``).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app

CONFIG = """
from chkit import define_config

config = define_config(
    {"schema": "./schema.py", "outDir": "./chkit", "migrationsDir": "./chkit/migrations",
     "metaDir": "./chkit/meta"}
)
"""


@pytest.fixture(autouse=True)
def _fresh_emit_flag() -> Iterator[None]:
    _reset_for_testing()
    yield
    _reset_for_testing()


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    (tmp_path / "schema.py").write_text("")
    return tmp_path


CASES = [
    (["generate", "foo"], "foo"),
    (["generate", "--dryrun", "-n", "x", "foo", "bar"], "foo bar"),
    (["migrate", "prod", "--apply"], "prod"),
    (["status", "foo"], "foo"),
    (["status", "-"], "-"),
    (["drift", "foo"], "foo"),
    (["check", "--table", "app.users", "foo"], "foo"),
    (["init", "foo", "--yes"], "foo"),
]


@pytest.mark.parametrize(("args", "extra"), CASES)
def test_a_stray_argument_prints_the_ts_message_and_exits_1(
    project: Path, args: list[str], extra: str
) -> None:
    result = CliRunner().invoke(app, args)
    assert (result.exit_code, result.stdout, result.stderr) == (
        1,
        "",
        f"Got unexpected extra argument(s) ({extra})\n",
    )
    assert sorted(path.name for path in project.iterdir()) == [
        "clickhouse.config.py",
        "schema.py",
    ]


@pytest.mark.usefixtures("project")
def test_a_stray_argument_under_json_writes_the_usage_envelope() -> None:
    result = CliRunner().invoke(app, ["status", "foo", "bar", "--json"])
    message = "Got unexpected extra argument(s) (foo bar)"
    assert (result.exit_code, result.stderr) == (1, f"{message}\n")
    assert json.loads(result.stdout) == {
        "command": "status",
        "schemaVersion": 1,
        "ok": False,
        "error": {"code": "usage", "message": message},
    }


@pytest.mark.usefixtures("project")
def test_a_flag_error_comes_before_a_stray_argument() -> None:
    result = CliRunner().invoke(app, ["migrate", "foo", "--bogus"])
    assert (result.exit_code, result.stderr) == (1, "Unknown flag: --bogus\n")


@pytest.mark.usefixtures("project")
def test_snapshot_keeps_its_subcommand_and_reports_its_own_extra_argument() -> None:
    result = CliRunner().invoke(app, ["snapshot", "rebuild", "foo"])
    assert result.exit_code == 1
    assert 'Unexpected argument "foo" for `chkit snapshot rebuild`.' in result.stderr
    assert CliRunner().invoke(app, ["snapshot", "rebuild", "--dryrun"]).exit_code == 0
