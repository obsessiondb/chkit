"""Read-only commands work for read-only ClickHouse users (#402).

Port of the TS ``read-only-user.e2e.test.ts``. ``status``, ``check`` and
``migrate`` (plan) read a missing journal as empty and never create it. A user
with ``readonly = 1`` or ``readonly = 2`` and only ``SELECT`` runs ``query``
(every digit, #381), ``status``, ``check``, ``drift`` and ``migrate`` (plan);
``migrate --apply`` fails with ClickHouse's own error, and a journal from before
per-operation tracking says it needs a user that can ALTER it.
"""

from __future__ import annotations

import json
import os
import secrets
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    quote_ident,
    resolve_live_env,
)

# ObsessionDB users have no CREATE USER (or any access-management) grant
# (#403), so the tests that create read-only users run in verify, against the
# local stack, only.
_ON_OBSESSIONDB = os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb"

SQL = (
    "SELECT toUInt64(18446744073709551615) AS u64max, "
    "toDecimal128('12345678901234567890.123456789', 9) AS d128, "
    "[toUInt64(18446744073709551615), 1] AS arr_u64, "
    "toNullable(toDecimal64('-12.345', 3)) AS nd, toUInt32(7) AS u32"
)
EXACT: dict[str, Any] = {
    "u64max": "18446744073709551615",
    "d128": "12345678901234567890.123456789",
    "arr_u64": ["18446744073709551615", "1"],
    "nd": "-12.345",
    "u32": 7,
}

Cli = Callable[..., dict[str, Any]]


@pytest.fixture
def admin() -> Iterator[ClickHouseClient]:
    env = resolve_live_env()
    with ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    ) as client:
        yield client


def _project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, label: str) -> tuple[str, str]:
    """Write the schema; return the table and the journal table names."""
    env = resolve_live_env()
    table = f"{create_prefix(label)}events"
    journal_table = create_journal_table_name(label)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.setenv("CI", "1")
    (tmp_path / "schema.py").write_text(
        "from chkit import ColumnDefinition, schema, table\n\n"
        f"events = table(database={env.clickhouse_database!r}, name={table!r}, "
        "engine='MergeTree()',\n"
        "    columns=[ColumnDefinition(name='id', type='UInt64'), "
        "ColumnDefinition(name='amount', type='Decimal(18, 4)')],\n"
        "    primary_key=['id'], order_by=['id'])\n\n"
        "definitions = schema(events)\n"
    )
    return table, journal_table


def _write_config(tmp_path: Path, username: str, password: str) -> str:
    env = resolve_live_env()
    path = tmp_path / f"{username}.config.py"
    path.write_text(
        "from chkit import define_config\n\nconfig = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "outDir": "./chkit",
            "migrationsDir": "./chkit/migrations",
            "metaDir": "./chkit/meta",
            "clickhouse": {
                "url": env.clickhouse_url,
                "username": username,
                "password": password,
                "database": env.clickhouse_database,
            },
        })
        + ")\n"
    )
    return str(path)


def _cli(config: str) -> Cli:
    def run(*args: str, exit_code: int = 0) -> dict[str, Any]:
        result = CliRunner().invoke(app, [*args, "--json", "--config", config])
        assert result.exit_code == exit_code, format_test_diagnostic(
            f"chkit {' '.join(args)} --json", result
        )
        return dict(json.loads(result.stdout))

    return run


def _journal_exists(admin: ClickHouseClient, name: str) -> bool:
    env = resolve_live_env()
    rows = admin.query(
        "SELECT name FROM system.tables "
        f"WHERE database = '{env.clickhouse_database}' AND name = '{name}'"
    ).rows
    return bool(rows)


def test_a_missing_journal_reads_as_empty_and_is_not_created(
    admin: ClickHouseClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    _, journal_table = _project(tmp_path, monkeypatch, "ro_missing_journal_py")
    chkit = _cli(_write_config(tmp_path, env.clickhouse_user, env.clickhouse_password))

    chkit("generate", "--name", "init")
    status = chkit("status")
    assert (status["applied"], status["pending"]) == (0, 1)
    assert "pending_migrations" in chkit("check", exit_code=1)["failedChecks"]
    assert chkit("migrate")["mode"] == "plan"

    assert not _journal_exists(admin, journal_table)


@pytest.mark.skipif(_ON_OBSESSIONDB, reason="ObsessionDB users have no CREATE USER grant (#403)")
@pytest.mark.parametrize("readonly", [1, 2])
def test_a_read_only_user_runs_the_read_only_commands(
    admin: ClickHouseClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, readonly: int
) -> None:
    env = resolve_live_env()
    table, journal_table = _project(tmp_path, monkeypatch, f"ro{readonly}_py")
    missing_journal = create_journal_table_name(f"ro{readonly}_missing_py")
    legacy_journal = create_journal_table_name(f"ro{readonly}_legacy_py")
    user, password = f"{create_prefix(f'ro{readonly}_py')}user", secrets.token_hex(16)
    as_admin = _cli(_write_config(tmp_path, env.clickhouse_user, env.clickhouse_password))
    as_user = _cli(_write_config(tmp_path, user, password))
    try:
        admin.execute(
            f"CREATE USER {quote_ident(user)} IDENTIFIED BY '{password}' "
            f"SETTINGS readonly = {readonly}"
        )
        admin.execute(f"GRANT SELECT ON *.* TO {quote_ident(user)}")
        as_admin("generate", "--name", "init")
        as_admin("migrate", "--apply")

        assert as_user("query", SQL)["data"] == [EXACT]
        table_out = CliRunner().invoke(
            app, ["query", SQL, "--config", str(tmp_path / f"{user}.config.py")]
        )
        assert table_out.exit_code == 0, format_test_diagnostic("query", table_out)
        assert [cell.strip() for cell in table_out.stdout.splitlines()[2].split("│")] == [
            EXACT["u64max"],
            EXACT["d128"],
            '["18446744073709551615","1"]',
            EXACT["nd"],
            "7",
        ]

        status = as_user("status")
        assert (status["applied"], status["pending"]) == (1, 0)
        check = as_user("check")
        assert (check["ok"], check["failedChecks"]) == (True, [])
        assert as_user("drift")["drifted"] is False
        plan = as_user("migrate")
        assert (plan["mode"], plan["pending"]) == ("plan", [])

        # A missing journal reads as no applied migrations, and writing one
        # fails with ClickHouse's own error.
        monkeypatch.setenv("CHKIT_JOURNAL_TABLE", missing_journal)
        status = as_user("status")
        assert (status["applied"], status["pending"]) == (0, 1)
        apply = as_user("migrate", "--apply", exit_code=1)
        assert apply["ok"] is False
        assert "Not enough privileges" in json.dumps(apply["error"])
        assert not _journal_exists(admin, missing_journal)

        # A journal from before per-operation tracking needs an ALTER the user
        # cannot run: say so.
        admin.execute(
            f"CREATE TABLE {quote_ident(env.clickhouse_database)}.{quote_ident(legacy_journal)} "
            "(name String, applied_at DateTime64(3, 'UTC'), checksum String, chkit_version String) "
            "ENGINE = ReplacingMergeTree(applied_at) ORDER BY name"
        )
        monkeypatch.setenv("CHKIT_JOURNAL_TABLE", legacy_journal)
        # The CLI runs in-process: the error envelope is written only when no
        # earlier invocation has written JSON.
        _reset_for_testing()
        legacy = CliRunner().invoke(
            app, ["status", "--json", "--config", str(tmp_path / f"{user}.config.py")]
        )
        assert legacy.exit_code == 1, format_test_diagnostic("status (legacy journal)", legacy)
        assert json.loads(legacy.stdout)["error"]["message"].startswith(
            f"The journal table {legacy_journal} predates per-operation tracking and needs "
            "its new columns added. Run chkit once as a user that can ALTER it"
        )
    finally:
        admin.execute(f"DROP USER IF EXISTS {quote_ident(user)}")
        for name in (table, journal_table, missing_journal, legacy_journal):
            admin.execute(
                f"DROP TABLE IF EXISTS {quote_ident(env.clickhouse_database)}.{quote_ident(name)} SYNC"
            )
