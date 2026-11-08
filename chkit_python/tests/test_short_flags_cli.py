"""Short flags read as in the TS CLI (#491): ``-t=x`` is ``--table x``, a bundle
such as ``-fd`` is an unknown option, ``-h`` is help and ``-v`` the version."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.main import get_command
from typer.testing import CliRunner

from chkit import __version__
from chkit.cli.main import _normalize_short_options, app

CONFIG = (
    'from chkit import define_config\n\nconfig = define_config({"schema": "./schema.py", '
    '"outDir": "./chkit"})\n'
)
SCHEMA = "".join(
    f"{name} = table(database='app', name='{name}', engine='MergeTree()', "
    "columns=[{'name': 'id', 'type': 'UInt64'}], primary_key=['id'], order_by=['id'])\n"
    for name in ("users", "events")
)


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    (tmp_path / "schema.py").write_text("from chkit import table\n\n" + SCHEMA)
    return tmp_path


def test_table_and_config_short_flags_read_like_the_long_flags(project: Path) -> None:
    config = str(project / "clickhouse.config.py")
    long = CliRunner().invoke(
        app, ["generate", "--config", config, "--table", "app.users", "--dryrun", "--json"]
    )
    assert long.exit_code == 0, long.output
    expected = json.loads(long.stdout)
    assert expected["scope"]["matchedTables"] == ["app.users"]

    for args in (
        ["-c", config, "-t", "app.users"],
        [f"-c={config}", "-t=app.users"],
        [f"-c{config}", "-tapp.users"],
    ):
        result = CliRunner().invoke(app, ["generate", *args, "--dryrun", "--json"])
        assert result.exit_code == 0, (args, result.output)
        assert json.loads(result.stdout) == expected, args


def test_a_bundle_of_short_flags_is_an_unknown_option(project: Path) -> None:
    for args, token in (
        (["pull", "-fd", "app"], "-fd"),
        (["init", "-yh"], "-yh"),
        (["status", "-hx"], "-hx"),
        (["init", "-y=1"], "-y=1"),
    ):
        result = CliRunner().invoke(app, args)
        assert result.exit_code == 2, (args, result.output)
        assert f"No such option: {token}" in result.output, args
    assert not (project / "src").exists()


def test_a_value_that_looks_like_a_short_flag_is_kept() -> None:
    params = get_command(app).commands["generate"].params  # type: ignore[attr-defined]
    assert _normalize_short_options(
        None, ["--name", "-t=x", "-t=app.users", "--", "-c=y"], params
    ) == ["--name", "-t=x", "-t", "app.users", "--", "-c=y"]


def test_h_is_help_and_v_is_the_version() -> None:
    for args in (["-h"], ["status", "-h"], ["plugin", "-h"], ["obsessiondb", "-h"]):
        result = CliRunner().invoke(app, args)
        assert result.exit_code == 0, (args, result.output)
        assert "Usage:" in result.output, args
    for flag in ("-v", "-V", "--version"):
        result = CliRunner().invoke(app, [flag])
        assert (result.exit_code, result.stdout) == (0, f"{__version__}\n")
