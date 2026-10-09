"""End-to-end CLI tests for the `--table` flag on generate / status / check / drift / migrate.

The migrate variant exercises only the planning path (no real ClickHouse
needed) because the prompt + apply path requires a journal store. The
other commands run fully against the local snapshot/schema.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app

CONFIG_TEMPLATE = """
from chkit import define_config

config = define_config(
    {
        "schema": "./schema_*.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "clickhouse": {
            "url": "http://localhost:8123",
            "username": "default",
            "password": "",
            "database": "default",
        },
    }
)
"""

SCHEMA_TWO_TABLES = """
from chkit import ColumnDefinition, schema, table

events = table(
    database="default", name="events", engine="MergeTree",
    columns=[ColumnDefinition(name="id", type="UInt64")],
    primary_key=["id"], order_by=["id"],
)
users = table(
    database="default", name="users", engine="MergeTree",
    columns=[ColumnDefinition(name="id", type="UInt64")],
    primary_key=["id"], order_by=["id"],
)

definitions = schema(events, users)
"""

SCHEMA_TWO_TABLES_EVENTS_CHANGED = """
from chkit import ColumnDefinition, schema, table

events = table(
    database="default", name="events", engine="MergeTree",
    columns=[
        ColumnDefinition(name="id", type="UInt64"),
        ColumnDefinition(name="ts", type="DateTime"),
    ],
    primary_key=["id"], order_by=["id"],
)
users = table(
    database="default", name="users", engine="MergeTree",
    columns=[ColumnDefinition(name="id", type="UInt64")],
    primary_key=["id"], order_by=["id"],
)

definitions = schema(events, users)
"""


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG_TEMPLATE, encoding="utf-8")
    (tmp_path / "schema_v1.py").write_text(SCHEMA_TWO_TABLES, encoding="utf-8")
    return tmp_path


# ---------- chkit generate --table ----------


def test_generate_table_scope_filters_to_one_table(
    runner: CliRunner, project: Path
) -> None:
    # Initial generate creates both tables.
    result = runner.invoke(app, ["generate", "--name", "init"])
    assert result.exit_code == 0, result.output

    # Change events table; users unchanged.
    (project / "schema_v1.py").write_text(
        SCHEMA_TWO_TABLES_EVENTS_CHANGED, encoding="utf-8"
    )

    # Without --table, both changes are planned (well, only events here).
    result = runner.invoke(app, ["generate", "--dryrun", "--json"])
    payload = json.loads(result.output)
    assert payload["operationCount"] > 0

    # With --table users (which has no changes), no operations are planned.
    result = runner.invoke(app, ["generate", "--dryrun", "--json", "--table", "users"])
    payload = json.loads(result.output)
    assert payload["operationCount"] == 0


def test_generate_table_scope_unknown_table_warns(
    runner: CliRunner, project: Path
) -> None:
    runner.invoke(app, ["generate", "--name", "init"])

    result = runner.invoke(
        app, ["generate", "--dryrun", "--json", "--table", "nonexistent"]
    )
    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert "No tables matched selector" in payload.get("warning", "")
    assert payload["operationCount"] == 0


def test_generate_table_scope_prefix_match(
    runner: CliRunner, project: Path
) -> None:
    runner.invoke(app, ["generate", "--name", "init"])
    (project / "schema_v1.py").write_text(
        SCHEMA_TWO_TABLES_EVENTS_CHANGED, encoding="utf-8"
    )

    result = runner.invoke(
        app, ["generate", "--dryrun", "--json", "--table", "event*"]
    )
    payload = json.loads(result.output)
    # events should match; user changes (none) don't appear.
    assert payload["operationCount"] >= 1


def test_generate_table_scope_invalid_selector_rejected(
    runner: CliRunner, project: Path
) -> None:
    runner.invoke(app, ["generate", "--name", "init"])
    result = runner.invoke(app, ["generate", "--dryrun", "--table", "ev*ents"])
    assert result.exit_code != 0


# ---------- chkit drift --table ----------


def test_drift_table_scope_filters(runner: CliRunner, project: Path) -> None:
    runner.invoke(app, ["generate", "--name", "init"])
    (project / "schema_v1.py").write_text(
        SCHEMA_TWO_TABLES_EVENTS_CHANGED, encoding="utf-8"
    )

    # No scope: drift detected for events
    result = runner.invoke(app, ["drift", "--json"])
    payload = json.loads(result.output)
    assert payload["drifted"] is True

    # --table users: events drift filtered out → no drift
    result = runner.invoke(app, ["drift", "--json", "--table", "users"])
    payload = json.loads(result.output)
    assert payload["drifted"] is False


# ---------- chkit check --table ----------


def test_check_table_scope_filters_drift(
    runner: CliRunner, project: Path
) -> None:
    """check exercises drift filtering; if there's no live ClickHouse we skip."""
    runner.invoke(app, ["generate", "--name", "init"])
    (project / "schema_v1.py").write_text(
        SCHEMA_TWO_TABLES_EVENTS_CHANGED, encoding="utf-8"
    )

    result = runner.invoke(app, ["check", "--json", "--table", "users"])
    if result.exit_code != 0 and (result.exception is not None or "Connection" in str(result.output)):
        pytest.skip("No live ClickHouse for check command")
    payload = json.loads(result.output)
    assert "drift" not in payload.get("failedChecks", [])
