"""Short flags read as in the TS CLI (#491): ``-t=x`` is ``--table x``, a bundle
such as ``-fd`` is an unknown option, ``-h`` is help and ``-v`` the version."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from typer.main import get_command
from typer.testing import CliRunner

from chkit import __version__
from chkit.cli.commands import codegen_shortcut
from chkit.cli.main import _normalize_short_options, app

# CI forces rich to colour usage errors.
ANSI_STYLE = re.compile(r"\x1b\[[0-9;]*m")

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
        assert f"No such option: {token}" in ANSI_STYLE.sub("", result.output), args
    assert not (project / "src").exists()


def test_a_value_that_looks_like_a_short_flag_is_kept() -> None:
    params = get_command(app).commands["generate"].params  # type: ignore[attr-defined]
    assert _normalize_short_options(
        None, ["--name", "-t=x", "-t=app.users", "--", "-c=y"], params
    ) == ["--name", "-t=x", "-t", "app.users", "--", "-c=y"]


def test_a_forwarder_reads_only_its_own_options_and_passes_the_rest_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        codegen_shortcut, "dispatch_plugin_command", lambda **kw: calls.append(kw)
    )
    for args, tokens, config in (
        # A plugin value that starts with -h is not the help option.
        (["--out-file", "-hmodels.py", "--json"], ["--out-file", "-hmodels.py"], None),
        # A bundle reaches the plugin, which rejects it as TS does, not click's help.
        (["-xh"], ["-xh"], None),
        (["--check", "-c=cfg.py", "--", "-c", "x"], ["--check", "--", "-c", "x"], "cfg.py"),
        (["-ccfg.py", "--check"], ["--check"], "cfg.py"),
        (["--config", "cfg.py", "--check"], ["--check"], "cfg.py"),
    ):
        calls.clear()
        result = CliRunner().invoke(app, ["codegen", *args])
        assert result.exit_code == 0, (args, result.output)
        assert len(calls) == 1, args
        assert calls[0]["tokens"] == tokens, args
        assert calls[0]["config_path"] == (Path(config) if config else None), args

    help_result = CliRunner().invoke(app, ["codegen", "--check", "-h"])
    assert help_result.exit_code == 0
    assert "Usage:" in help_result.output


def test_a_forwarder_option_without_its_value_is_a_usage_error() -> None:
    for command in (["codegen"], ["plugin", "codegen", "codegen"], ["obsessiondb", "login"]):
        for option in ("--config", "-c"):
            args = [*command, "--out-file", "-hmodels.py", option]
            result = CliRunner().invoke(app, args)
            output = ANSI_STYLE.sub("", result.output)
            assert result.exit_code == 2, (args, output)
            assert f"Option '{option}' requires an argument." in output, args
            # A usage error, not the help that a forwarded -h would print.
            assert "Options" not in output, args


def test_h_is_help_and_v_is_the_version() -> None:
    for args in (["-h"], ["status", "-h"], ["plugin", "-h"], ["obsessiondb", "-h"]):
        result = CliRunner().invoke(app, args)
        assert result.exit_code == 0, (args, result.output)
        assert "Usage:" in result.output, args
    for flag in ("-v", "-V", "--version"):
        result = CliRunner().invoke(app, [flag])
        assert (result.exit_code, result.stdout) == (0, f"{__version__}\n")
