"""Regression tests for ``chkit.cli.migration_store``.

In particular, ``pending_migrations()`` must subtract applied ids from the
filesystem listing. ``chkit check`` had a bug in 0.1.0 where it reported every
migration on disk as pending, regardless of ``applied.json``.
"""

from __future__ import annotations

from pathlib import Path

from chkit.cli.migration_store import (
    list_migrations,
    pending_migrations,
    read_applied,
    write_applied,
)


def _write_migration(migrations_dir: Path, migration_id: str) -> None:
    migrations_dir.mkdir(parents=True, exist_ok=True)
    (migrations_dir / f"{migration_id}.sql").write_text(
        "CREATE TABLE foo (id UInt64) ENGINE = MergeTree() ORDER BY id;\n",
        encoding="utf-8",
    )


def test_pending_is_all_when_no_applied(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    meta_dir = tmp_path / "meta"
    _write_migration(migrations_dir, "20260101000000_initial")
    _write_migration(migrations_dir, "20260102000000_followup")

    # 1:1 with TS: pending entries are full filenames (with .sql), not stems.
    assert pending_migrations(migrations_dir, meta_dir) == [
        "20260101000000_initial.sql",
        "20260102000000_followup.sql",
    ]


def test_pending_excludes_applied_ids(tmp_path: Path) -> None:
    """Bug fixed in 0.1.1: ``check`` was ignoring applied.json."""
    migrations_dir = tmp_path / "migrations"
    meta_dir = tmp_path / "meta"
    _write_migration(migrations_dir, "20260101000000_initial")
    _write_migration(migrations_dir, "20260102000000_followup")
    write_applied(meta_dir, {"20260101000000_initial.sql"})

    assert pending_migrations(migrations_dir, meta_dir) == [
        "20260102000000_followup.sql"
    ]


def test_pending_empty_when_all_applied(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    meta_dir = tmp_path / "meta"
    _write_migration(migrations_dir, "20260101000000_initial")
    write_applied(meta_dir, {"20260101000000_initial.sql"})

    assert pending_migrations(migrations_dir, meta_dir) == []


def test_read_applied_empty_when_no_file(tmp_path: Path) -> None:
    assert read_applied(tmp_path) == set()


def test_write_then_read_applied_roundtrip(tmp_path: Path) -> None:
    write_applied(tmp_path, {"b", "a", "c"})
    # write_applied sorts on disk; read_applied returns a set.
    assert read_applied(tmp_path) == {"a", "b", "c"}


def test_list_migrations_returns_sorted_paths(tmp_path: Path) -> None:
    migrations_dir = tmp_path / "migrations"
    _write_migration(migrations_dir, "20260102000000_b")
    _write_migration(migrations_dir, "20260101000000_a")
    stems = [p.stem for p in list_migrations(migrations_dir)]
    assert stems == ["20260101000000_a", "20260102000000_b"]


def test_list_migrations_returns_empty_when_dir_missing(tmp_path: Path) -> None:
    assert list_migrations(tmp_path / "nope") == []
