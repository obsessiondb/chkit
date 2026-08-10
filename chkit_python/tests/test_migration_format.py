"""Tests for the migration SQL artifact format.

1:1 parity targets with the TypeScript ``buildMigrationContent`` /
``generateArtifacts`` helpers in ``packages/codegen/src/index.ts``.
"""

from __future__ import annotations

from pathlib import Path

from chkit.cli.migration_store import (
    safe_migration_id,
    safe_name,
    write_migration,
)
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import table
from chkit.core.planner import plan_diff


def _events() -> list:
    return canonicalize_definitions(
        [
            table(
                database="default",
                name="events",
                columns=[{"name": "id", "type": "UInt64"}],
                engine="MergeTree()",
                primaryKey=["id"],
                orderBy=["id"],
            )
        ]
    )


def test_safe_name_lowercases_and_replaces_invalid_chars() -> None:
    assert safe_name("My Migration!") == "my_migration_"
    assert safe_name("Add-Column.2") == "add-column_2"
    assert safe_name("ALL_GOOD-123") == "all_good-123"


def test_safe_migration_id_strips_invalid_chars() -> None:
    assert safe_migration_id("v1.2.3 !") == "v123"
    assert safe_migration_id("only-good_chars") == "only-good_chars"


def test_write_migration_writes_header_with_metadata(tmp_path: Path) -> None:
    plan = plan_diff([], _events())
    artifact = write_migration(
        tmp_path / "migrations",
        tmp_path / "meta",
        _events(),
        plan,
        migration_name="initial",
        cli_version="9.9.9",
    )
    assert artifact is not None
    sql = artifact.sql_path.read_text(encoding="utf-8")
    assert sql.startswith("-- chkit-migration-format: v1\n")
    assert "-- cli-version: 9.9.9\n" in sql
    assert "-- definition-count: 1\n" in sql
    assert f"-- operation-count: {len(plan.operations)}\n" in sql
    assert "-- risk-summary: safe=" in sql


def test_write_migration_includes_per_operation_comments(tmp_path: Path) -> None:
    plan = plan_diff([], _events())
    artifact = write_migration(
        tmp_path / "migrations",
        tmp_path / "meta",
        _events(),
        plan,
        migration_name="initial",
        cli_version="0.0.0",
    )
    assert artifact is not None
    sql = artifact.sql_path.read_text(encoding="utf-8")
    for op in plan.operations:
        assert f"-- operation: {op.type} key={op.key} risk={op.risk}" in sql
        assert op.sql in sql


def test_write_migration_uses_safe_name(tmp_path: Path) -> None:
    plan = plan_diff([], _events())
    artifact = write_migration(
        tmp_path / "migrations",
        tmp_path / "meta",
        _events(),
        plan,
        migration_name="Add Events!",
        cli_version="0.1.3",
    )
    assert artifact is not None
    assert artifact.sql_path.name.endswith("_add_events_.sql")


def test_write_migration_honours_migration_id_override(tmp_path: Path) -> None:
    plan = plan_diff([], _events())
    artifact = write_migration(
        tmp_path / "migrations",
        tmp_path / "meta",
        _events(),
        plan,
        migration_name="init",
        migration_id="custom-id_99",
        cli_version="0.1.3",
    )
    assert artifact is not None
    assert artifact.sql_path.name == "custom-id_99_init.sql"


def test_write_migration_returns_none_for_empty_plan(tmp_path: Path) -> None:
    plan = plan_diff(_events(), _events())
    artifact = write_migration(
        tmp_path / "migrations",
        tmp_path / "meta",
        _events(),
        plan,
        migration_name="noop",
        cli_version="0.1.3",
    )
    assert artifact is None
    if (tmp_path / "migrations").exists():
        assert list((tmp_path / "migrations").glob("*.sql")) == []


def test_write_migration_collision_appends_numeric_suffix(tmp_path: Path) -> None:
    plan = plan_diff([], _events())
    a = write_migration(
        tmp_path / "migrations",
        tmp_path / "meta",
        _events(),
        plan,
        migration_name="dupe",
        migration_id="fixed-stamp",
        cli_version="0.1.3",
    )
    b = write_migration(
        tmp_path / "migrations",
        tmp_path / "meta",
        _events(),
        plan,
        migration_name="dupe",
        migration_id="fixed-stamp",
        cli_version="0.1.3",
    )
    assert a is not None
    assert b is not None
    assert a.sql_path.name == "fixed-stamp_dupe.sql"
    assert b.sql_path.name == "fixed-stamp_dupe_001.sql"


def test_write_migration_writes_trailing_newline(tmp_path: Path) -> None:
    plan = plan_diff([], _events())
    artifact = write_migration(
        tmp_path / "migrations",
        tmp_path / "meta",
        _events(),
        plan,
        migration_name="init",
        cli_version="0.1.3",
    )
    assert artifact is not None
    sql = artifact.sql_path.read_text(encoding="utf-8")
    assert sql.endswith("\n")
