"""Port of the load-failure cases in ``packages/core/src/schema-loader.test.ts``.

A schema file that fails to import names the file and the parser position, and
says which file holds git conflict markers when they caused the failure. The
Bun/jiti module-cache cases (second import of a failed module) do not apply to
Python, which compiles each schema file afresh; the same-error-twice
expectation is still checked.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from chkit.core import SchemaFileLoadError, load_schema_definitions

SCHEMA = """from chkit import schema, table

users = table(
    database="app",
    name="users",
    columns=[{"name": "id", "type": "UInt64"}],
    engine="MergeTree()",
    primary_key=["id"],
    order_by=["id"],
)

definitions = schema(users)
"""

CONFLICTED_SCHEMA = SCHEMA.replace(
    '    columns=[{"name": "id", "type": "UInt64"}],\n',
    "<<<<<<< HEAD\n"
    '    columns=[{"name": "id", "type": "UInt64"}],\n'
    "=======\n"
    '    columns=[{"name": "id", "type": "UInt64"}, {"name": "email", "type": "String"}],\n'
    ">>>>>>> feature\n",
)

CONFLICTED_SHARED = (
    'engine = "MergeTree()"\n'
    "<<<<<<< HEAD\n"
    'db = "app"\n'
    "=======\n"
    'db = "analytics"\n'
    ">>>>>>> feature\n"
)

HINT = "contains unresolved merge conflict markers. Resolve the conflict and run the command again."


def _schema_dir(tmp_path: Path, files: dict[str, str]) -> Path:
    # Real path: the loader reports files by their resolved path, and on macOS
    # the temp directory sits behind the /var symlink.
    root = Path(os.path.realpath(tmp_path))
    for name, content in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(content, encoding="utf-8")
    return root


def _load_error(cwd: Path, glob: str) -> str:
    with pytest.raises(SchemaFileLoadError) as error:
        load_schema_definitions(glob, cwd=cwd)
    return str(error.value)


def test_loads_the_definitions_of_every_matched_file(tmp_path: Path) -> None:
    root = _schema_dir(tmp_path, {"app.py": SCHEMA})

    definitions = load_schema_definitions("*.py", cwd=root)

    assert [f"{d.kind}:{d.database}.{d.name}" for d in definitions] == ["table:app.users"]


def test_names_a_schema_file_that_still_has_merge_conflict_markers(tmp_path: Path) -> None:
    root = _schema_dir(tmp_path, {"app.py": CONFLICTED_SCHEMA})
    file = root / "app.py"

    message = _load_error(root, "*.py")

    # The parser's own error first, then the hint.
    assert message.startswith(f"Failed to load schema file {file}: SyntaxError: ")
    assert f"({file}:" in message
    assert message.endswith(f"\nThe file {HINT}")


def test_names_the_imported_module_that_holds_the_conflict_markers(tmp_path: Path) -> None:
    root = _schema_dir(tmp_path, {"shared_conflicted_mod.py": CONFLICTED_SHARED})
    entry = (
        "import sys\n"
        f"sys.path.insert(0, {str(root)!r})\n"
        "from shared_conflicted_mod import db, engine\n"
        "from chkit import schema, table\n\n"
        "definitions = schema(table(database=db, name='users', "
        "columns=[{'name': 'id', 'type': 'UInt64'}], engine=engine, "
        "primary_key=['id'], order_by=['id']))\n"
    )
    _schema_dir(tmp_path, {"app.py": entry})
    try:
        message = _load_error(root, "app.py")
    finally:
        sys.path.remove(str(root))

    assert message.startswith(f"Failed to load schema file {root / 'app.py'}: ")
    assert message.endswith(f"\n{root / 'shared_conflicted_mod.py'} {HINT}")


def test_names_a_schema_file_with_a_syntax_error_and_leaves_the_hint_out(tmp_path: Path) -> None:
    root = _schema_dir(
        tmp_path, {"app.py": SCHEMA.replace('primary_key=["id"],', 'primary_key=["id",,')}
    )
    file = root / "app.py"

    message = _load_error(root, "*.py")

    assert message.startswith(f"Failed to load schema file {file}: SyntaxError: ")
    assert f"({file}:" in message
    assert "conflict markers" not in message


def test_a_second_load_of_a_file_that_failed_to_parse_fails_the_same_way(tmp_path: Path) -> None:
    root = _schema_dir(tmp_path, {"app.py": CONFLICTED_SCHEMA})

    assert _load_error(root, "*.py") == _load_error(root, "*.py")


def test_a_file_that_raised_while_evaluating_names_the_file_and_the_error(tmp_path: Path) -> None:
    throwing = SCHEMA.replace(
        "definitions =", "settings: dict[str, str] = {}\nttl = settings['events']\ndefinitions ="
    )
    root = _schema_dir(tmp_path, {"app.py": throwing})

    first = _load_error(root, "*.py")

    assert first == f"Failed to load schema file {root / 'app.py'}: KeyError: 'events'"
    assert _load_error(root, "*.py") == first
