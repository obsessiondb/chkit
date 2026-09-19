"""End-to-end CLI tests for `chkit generate --rename-table / --rename-column`."""

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

INITIAL_SCHEMA = """
from chkit import ColumnDefinition, schema, table

events_old = table(
    database="default",
    name="events_old",
    engine="MergeTree",
    columns=[
        ColumnDefinition(name="id", type="UInt64"),
        ColumnDefinition(name="legacy_col", type="String"),
    ],
    primary_key=["id"],
    order_by=["id"],
)

definitions = schema(events_old)
"""

RENAMED_TABLE_SCHEMA = """
from chkit import ColumnDefinition, schema, table

events = table(
    database="default",
    name="events",
    engine="MergeTree",
    columns=[
        ColumnDefinition(name="id", type="UInt64"),
        ColumnDefinition(name="legacy_col", type="String"),
    ],
    primary_key=["id"],
    order_by=["id"],
)

definitions = schema(events)
"""

RENAMED_COLUMN_SCHEMA = """
from chkit import ColumnDefinition, schema, table

events_old = table(
    database="default",
    name="events_old",
    engine="MergeTree",
    columns=[
        ColumnDefinition(name="id", type="UInt64"),
        ColumnDefinition(name="new_col", type="String"),
    ],
    primary_key=["id"],
    order_by=["id"],
)

definitions = schema(events_old)
"""


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG_TEMPLATE, encoding="utf-8")
    (tmp_path / "schema_v1.py").write_text(INITIAL_SCHEMA, encoding="utf-8")
    return tmp_path


def _generate_initial_snapshot(runner: CliRunner) -> None:
    """Run a first generate so a snapshot exists for the rename tests to compare against."""
    result = runner.invoke(app, ["generate", "--name", "init"])
    assert result.exit_code == 0, result.output


def test_rename_table_emits_rename_operation(
    runner: CliRunner, project: Path
) -> None:
    _generate_initial_snapshot(runner)
    # Swap to the renamed schema.
    (project / "schema_v1.py").write_text(RENAMED_TABLE_SCHEMA, encoding="utf-8")

    result = runner.invoke(
        app,
        [
            "generate",
            "--dryrun",
            "--json",
            "--rename-table",
            "default.events_old=default.events",
        ],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    operation_types = [op["type"] for op in payload["operations"]]
    assert "alter_table_rename_table" in operation_types
    # Should not also include a drop+create pair for these tables.
    assert "drop_table" not in operation_types
    assert "create_table" not in operation_types


def test_rename_column_collapses_drop_add_into_rename(
    runner: CliRunner, project: Path
) -> None:
    _generate_initial_snapshot(runner)
    (project / "schema_v1.py").write_text(RENAMED_COLUMN_SCHEMA, encoding="utf-8")

    result = runner.invoke(
        app,
        [
            "generate",
            "--dryrun",
            "--json",
            "--rename-column",
            "default.events_old.legacy_col=new_col",
        ],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    types_seen = {op["type"] for op in payload["operations"]}
    assert "alter_table_rename_column" in types_seen
    assert "alter_table_drop_column" not in types_seen
    assert "alter_table_add_column" not in types_seen


def test_rename_table_with_invalid_mapping_fails(
    runner: CliRunner, project: Path
) -> None:
    _generate_initial_snapshot(runner)
    (project / "schema_v1.py").write_text(RENAMED_TABLE_SCHEMA, encoding="utf-8")

    result = runner.invoke(
        app,
        [
            "generate",
            "--dryrun",
            "--rename-table",
            "default.ghost=default.events",
        ],
    )
    assert result.exit_code != 0
    assert (
        "source table is missing" in result.output
        or "source table is missing" in str(result.exception)
    )


def test_rename_table_with_malformed_mapping_fails(
    runner: CliRunner, project: Path
) -> None:
    _generate_initial_snapshot(runner)
    result = runner.invoke(
        app,
        [
            "generate",
            "--dryrun",
            "--rename-table",
            "no_equals_here",
        ],
    )
    assert result.exit_code != 0


def test_repeatable_rename_flags(
    runner: CliRunner, project: Path, tmp_path: Path
) -> None:
    """Two --rename-table flags should both be respected."""
    # Initial: two tables.
    initial = """
from chkit import ColumnDefinition, schema, table

a_old = table(
    database="default", name="a_old", engine="MergeTree",
    columns=[ColumnDefinition(name="id", type="UInt64")],
    primary_key=["id"], order_by=["id"],
)
b_old = table(
    database="default", name="b_old", engine="MergeTree",
    columns=[ColumnDefinition(name="id", type="UInt64")],
    primary_key=["id"], order_by=["id"],
)

definitions = schema(a_old, b_old)
"""
    (project / "schema_v1.py").write_text(initial, encoding="utf-8")
    _generate_initial_snapshot(runner)

    renamed = """
from chkit import ColumnDefinition, schema, table

a_new = table(
    database="default", name="a_new", engine="MergeTree",
    columns=[ColumnDefinition(name="id", type="UInt64")],
    primary_key=["id"], order_by=["id"],
)
b_new = table(
    database="default", name="b_new", engine="MergeTree",
    columns=[ColumnDefinition(name="id", type="UInt64")],
    primary_key=["id"], order_by=["id"],
)

definitions = schema(a_new, b_new)
"""
    (project / "schema_v1.py").write_text(renamed, encoding="utf-8")

    result = runner.invoke(
        app,
        [
            "generate",
            "--dryrun",
            "--json",
            "--rename-table",
            "default.a_old=default.a_new",
            "--rename-table",
            "default.b_old=default.b_new",
        ],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    rename_count = sum(
        1 for op in payload["operations"] if op["type"] == "alter_table_rename_table"
    )
    assert rename_count == 2
