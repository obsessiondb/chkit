"""Tests for `chkit.core.schema_loader.load_schema_definitions`."""

from __future__ import annotations

from pathlib import Path

import pytest

from chkit import load_schema_definitions
from chkit.core.model import (
    MaterializedViewDefinition,
    TableDefinition,
    ViewDefinition,
)
from chkit.core.schema_loader import NO_MATCH_MESSAGE, SchemaLoaderError
from chkit.core.schema_loader import (
    load_schema_definitions as load_from_module,
)

SCHEMA_MODULE = """
from chkit import ColumnDefinition, table, view

events = table(
    database="default",
    name="events",
    engine="MergeTree",
    columns=[ColumnDefinition(name="ts", type="DateTime")],
    primary_key=["ts"],
    order_by=["ts"],
)

agg = view(database="default", name="agg", as_="SELECT 1")
"""

SECOND_SCHEMA_MODULE = """
from chkit import ColumnDefinition, table

users = table(
    database="default",
    name="users",
    engine="MergeTree",
    columns=[ColumnDefinition(name="id", type="UInt64")],
    primary_key=["id"],
    order_by=["id"],
)
"""


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def test_loads_single_string_glob(tmp_path: Path) -> None:
    _write(tmp_path / "schema.py", SCHEMA_MODULE)
    defs = load_schema_definitions("schema.py", cwd=tmp_path)
    names = sorted(d.name for d in defs)
    assert names == ["agg", "events"]


def test_loads_list_of_globs(tmp_path: Path) -> None:
    _write(tmp_path / "schema.py", SCHEMA_MODULE)
    _write(tmp_path / "second.py", SECOND_SCHEMA_MODULE)
    defs = load_schema_definitions(["schema.py", "second.py"], cwd=tmp_path)
    names = sorted(d.name for d in defs)
    assert names == ["agg", "events", "users"]


def test_recursive_glob_matches(tmp_path: Path) -> None:
    _write(tmp_path / "src" / "db" / "schema" / "first.py", SCHEMA_MODULE)
    _write(tmp_path / "src" / "db" / "schema" / "second.py", SECOND_SCHEMA_MODULE)
    defs = load_schema_definitions("src/db/schema/**/*.py", cwd=tmp_path)
    names = sorted(d.name for d in defs)
    assert names == ["agg", "events", "users"]


def test_returned_definitions_have_correct_kinds(tmp_path: Path) -> None:
    _write(tmp_path / "schema.py", SCHEMA_MODULE)
    defs = load_schema_definitions("schema.py", cwd=tmp_path)
    kinds = {d.kind for d in defs}
    assert kinds == {"table", "view"}
    assert any(isinstance(d, TableDefinition) for d in defs)
    assert any(isinstance(d, ViewDefinition) for d in defs)
    assert not any(isinstance(d, MaterializedViewDefinition) for d in defs)


def test_raises_when_no_files_matched(tmp_path: Path) -> None:
    with pytest.raises(SchemaLoaderError) as excinfo:
        load_schema_definitions("does_not_exist/**/*.py", cwd=tmp_path)
    assert str(excinfo.value) == NO_MATCH_MESSAGE


def test_uses_cwd_when_none_given(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    _write(tmp_path / "schema.py", SCHEMA_MODULE)
    defs = load_schema_definitions("schema.py")
    names = sorted(d.name for d in defs)
    assert names == ["agg", "events"]


def test_accepts_str_cwd(tmp_path: Path) -> None:
    _write(tmp_path / "schema.py", SCHEMA_MODULE)
    defs = load_schema_definitions("schema.py", cwd=str(tmp_path))
    assert {d.name for d in defs} == {"events", "agg"}


def test_absolute_glob_ignores_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(tmp_path / "schema.py", SCHEMA_MODULE)
    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.chdir(other)
    defs = load_schema_definitions(str(tmp_path / "schema.py"))
    assert {d.name for d in defs} == {"events", "agg"}


def test_duplicate_files_in_globs_are_deduped(tmp_path: Path) -> None:
    _write(tmp_path / "schema.py", SCHEMA_MODULE)
    defs = load_schema_definitions(
        ["schema.py", "schema.py", "**/schema.py"],
        cwd=tmp_path,
    )
    names = sorted(d.name for d in defs)
    assert names == ["agg", "events"]


def test_reexport_from_top_level_matches_module() -> None:
    assert load_schema_definitions is load_from_module
