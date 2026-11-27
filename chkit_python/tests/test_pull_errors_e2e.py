"""pull reports its errors as the TS pull plugin does (#487): on stdout, as
``Pull schema failed: <message>`` or the ``{ok, command, error}`` envelope,
with exit 2 for a config error and 1 for any other error."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from tests.e2e_testkit import create_prefix, format_test_diagnostic, resolve_live_env


def _write_config(tmp_path: Path, database: str) -> None:
    env = resolve_live_env()
    clickhouse = json.dumps(
        {
            "url": env.clickhouse_url,
            "username": env.clickhouse_user,
            "password": env.clickhouse_password,
            "database": database,
        }
    )
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\n"
        "config = define_config({\n"
        '    "schema": "./schema.py",\n'
        '    "outDir": "./chkit",\n'
        '    "migrationsDir": "./chkit/migrations",\n'
        '    "metaDir": "./chkit/meta",\n'
        f'    "clickhouse": {clickhouse},\n'
        "})\n"
    )


def _pull(*args: str) -> Any:
    return CliRunner().invoke(app, ["pull", *args])


def test_pull_reports_an_existing_out_file_as_ts_does(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    _write_config(tmp_path, resolve_live_env().clickhouse_database)
    # A database that does not exist: pull writes an empty schema.
    args = ["--database", f"{create_prefix('pull_err_py')}db", "--out-file", "pulled.py"]
    message = (
        f"Output file already exists at {tmp_path.resolve() / 'pulled.py'}. "
        "Re-run with --force or set plugin option overwrite=true."
    )

    first = _pull(*args)
    assert first.exit_code == 0, format_test_diagnostic("chkit pull", first)

    text = _pull(*args)
    assert (text.exit_code, text.stdout, text.stderr) == (
        2,
        f"Pull schema failed: {message}\n",
        "",
    )

    as_json = _pull(*args, "--json")
    assert (as_json.exit_code, as_json.stderr) == (2, "")
    assert json.loads(as_json.stdout) == {"ok": False, "command": "schema", "error": message}

    forced = _pull(*args, "--force")
    assert forced.exit_code == 0, format_test_diagnostic("chkit pull --force", forced)


def test_pull_reports_a_clickhouse_error_as_ts_does(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    database = f"{create_prefix('pull_err_py')}missing"
    _write_config(tmp_path, database)
    # ClickHouse's own message, which can add a hint after the first sentence.
    message = f"Database {database} does not exist."

    text = _pull("--dryrun")
    assert (text.exit_code, text.stderr) == (1, "")
    assert text.stdout.startswith(f"Pull schema failed: {message}"), text.stdout

    as_json = _pull("--dryrun", "--json")
    assert (as_json.exit_code, as_json.stderr) == (1, "")
    payload = json.loads(as_json.stdout)
    assert payload == {"ok": False, "command": "schema", "error": payload["error"]}
    assert payload["error"].startswith(message), payload["error"]
