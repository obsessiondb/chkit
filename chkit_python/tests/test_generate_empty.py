"""Port of ``packages/cli/src/test/generate-empty.test.ts`` and the
``generateEmptyMigration`` cases in ``packages/codegen/src/index.test.ts``."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.cli.migration_store import generate_empty_migration

CONFIG = (
    'from chkit import define_config\n\nconfig = define_config({"schema": "./schema.py", '
    '"outDir": "./chkit", "migrationsDir": "./chkit/migrations", "metaDir": "./chkit/meta"})\n'
)
SCHEMA = (
    "from chkit import schema, table\n\n"
    "events = table(database='app', name='events', columns=[{'name': 'id', 'type': 'UInt64'}],"
    " engine='MergeTree()', primary_key=['id'], order_by=['id'])\n\n"
    "definitions = schema(events)\n"
)
NOW = datetime(2026, 1, 2, 3, 4, 5, 678000, tzinfo=UTC)


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    (tmp_path / "schema.py").write_text(SCHEMA)
    return tmp_path


def test_scaffolds_a_blank_migration_and_leaves_the_snapshot_untouched(project: Path) -> None:
    result = CliRunner().invoke(
        app,
        [
            "generate",
            "--empty",
            "--name",
            "backfill signups",
            "--migration-id",
            "20260101000000",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["command"] == "generate"
    assert payload["mode"] == "empty"
    assert payload["migrationFile"].endswith("20260101000000_backfill_signups.sql")

    migration = Path(payload["migrationFile"]).read_text(encoding="utf-8")
    assert "-- chkit-migration-format: v1" in migration
    assert "-- operation-count: 0" in migration
    assert "-- Empty migration scaffold. Write your SQL statements below." in migration
    assert "CREATE TABLE" not in migration
    # Empty mode must never write a snapshot — otherwise it would silently
    # absorb pending schema drift.
    assert not (project / "chkit" / "meta" / "snapshot.json").exists()


def test_defaults_the_migration_name_to_manual(project: Path) -> None:
    result = CliRunner().invoke(
        app, ["generate", "--empty", "--migration-id", "20260101000000", "--json"]
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["migrationFile"].endswith("20260101000000_manual.sql")


def test_human_output_points_at_the_file(project: Path) -> None:
    result = CliRunner().invoke(app, ["generate", "--empty", "--migration-id", "20260101000000"])

    assert result.exit_code == 0, result.output
    assert "Generated empty migration: " in result.stdout
    assert 'Snapshot unchanged. Add your SQL to the file, then run "chkit migrate".' in result.stdout


def test_writes_a_blank_migration_stub_without_touching_a_snapshot(tmp_path: Path) -> None:
    artifact = generate_empty_migration(
        tmp_path / "migrations", migration_name="seed data", cli_version="0.0.0", now=NOW
    )

    assert artifact.sql_path.name == "20260102030405_seed_data.sql"
    sql = artifact.sql_path.read_text(encoding="utf-8")
    assert sql == (
        "-- chkit-migration-format: v1\n"
        "-- generated-at: 2026-01-02T03:04:05.678000Z\n"
        "-- cli-version: 0.0.0\n"
        "-- definition-count: 0\n"
        "-- operation-count: 0\n"
        "-- rename-suggestion-count: 0\n"
        "-- risk-summary: safe=0, caution=0, danger=0\n"
        "\n"
        "-- Empty migration scaffold. Write your SQL statements below.\n"
        "-- Statements run in order and are separated by semicolons.\n"
    )
    assert not (tmp_path / "meta").exists()


def test_avoids_overwriting_a_stub_generated_in_the_same_second(tmp_path: Path) -> None:
    first = generate_empty_migration(tmp_path, cli_version="0.0.0", now=NOW)
    second = generate_empty_migration(tmp_path, cli_version="0.0.0", now=NOW)

    assert first.sql_path.name == "20260102030405_manual.sql"
    assert second.sql_path.name == "20260102030405_manual_001.sql"


def test_a_no_op_plan_reports_a_null_migration_file_and_refreshes_the_snapshot(
    project: Path,
) -> None:
    first = CliRunner().invoke(app, ["generate", "--json"])
    assert first.exit_code == 0, first.output
    assert json.loads(first.stdout)["migrationFile"]

    second = CliRunner().invoke(app, ["generate", "--json"])
    assert second.exit_code == 0, second.output
    payload = json.loads(second.stdout)
    assert payload["migrationFile"] is None
    assert payload["operationCount"] == 0
    assert payload["definitionCount"] == 1
    assert Path(payload["snapshotFile"]).exists()
    assert len(list((project / "chkit" / "migrations").glob("*.sql"))) == 1

    text = CliRunner().invoke(app, ["generate"])
    assert text.exit_code == 0, text.output
    assert "No migration generated: plan is empty." in text.stdout
