"""End-to-end: ``chkit generate`` stamps ``ON CLUSTER`` when configured.

Complements ``tests/test_on_cluster.py`` — those unit-test the injector; this
runs the actual CLI against a config with ``clickhouse.cluster`` set and
asserts every DDL line in the emitted migration carries the clause. Mirrors
the behavioral contract of the TS cluster e2e (which needs a live 2-node
cluster and is deferred; see DRIFT.md).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app

CONFIG_WITH_CLUSTER = """
from chkit import define_config

config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "clickhouse": {
            "url": "http://localhost:8123",
            "username": "default",
            "password": "",
            "database": "default",
            "cluster": "prod",
        },
    }
)
"""

CONFIG_WITHOUT_CLUSTER = """
from chkit import define_config

config = define_config(
    {
        "schema": "./schema.py",
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

SCHEMA = """
from chkit import ColumnDefinition, schema, table

events = table(
    database="default",
    name="events",
    engine="MergeTree",
    columns=[
        ColumnDefinition(name="id", type="UInt64"),
        ColumnDefinition(name="payload", type="String"),
    ],
    primary_key=["id"],
    order_by=["id"],
)

definitions = schema(events)
"""


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


def _write_project(tmp_path: Path, config: str) -> None:
    (tmp_path / "clickhouse.config.py").write_text(config, encoding="utf-8")
    (tmp_path / "schema.py").write_text(SCHEMA, encoding="utf-8")


def test_generate_json_stamps_on_cluster_when_cluster_configured(
    runner: CliRunner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    _write_project(tmp_path, CONFIG_WITH_CLUSTER)

    result = runner.invoke(
        app,
        ["generate", "--dryrun", "--json", "--name", "init"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    ops = payload["operations"]
    assert ops, "expected at least one operation"
    for op in ops:
        assert "ON CLUSTER 'prod'" in op["sql"], op["sql"]


def test_generate_omits_on_cluster_when_cluster_not_configured(
    runner: CliRunner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    _write_project(tmp_path, CONFIG_WITHOUT_CLUSTER)

    result = runner.invoke(
        app,
        ["generate", "--dryrun", "--json", "--name", "init"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    ops = payload["operations"]
    assert ops, "expected at least one operation"
    for op in ops:
        assert "ON CLUSTER" not in op["sql"], op["sql"]


def test_generate_writes_migration_file_with_on_cluster_stamped(
    runner: CliRunner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Not --dryrun this time: write the actual migration file to disk and
    # assert the baked SQL carries ON CLUSTER. This is the shape ``migrate``
    # will re-read and execute verbatim — no re-injection needed there.
    monkeypatch.chdir(tmp_path)
    _write_project(tmp_path, CONFIG_WITH_CLUSTER)

    result = runner.invoke(
        app,
        ["generate", "--name", "init"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0, result.output
    migrations_dir = tmp_path / "chkit" / "migrations"
    files = sorted(migrations_dir.glob("*.sql"))
    assert files, "expected a migration file to be written"
    body = files[0].read_text(encoding="utf-8")
    # The CREATE DATABASE (if emitted) and CREATE TABLE must carry the clause.
    assert "ON CLUSTER 'prod'" in body, body
    if "CREATE TABLE" in body:
        # Sanity: at least the CREATE TABLE line has the clause.
        assert "CREATE TABLE" in body
        create_line = next(
            line for line in body.splitlines() if line.startswith("CREATE TABLE")
        )
        assert "ON CLUSTER 'prod'" in create_line
