"""Tests for `chkit.core.ts_import.import_module_file`."""

from __future__ import annotations

from pathlib import Path

import pytest

from chkit import import_module_file
from chkit.core.ts_import import ModuleLoadError
from chkit.core.ts_import import import_module_file as import_from_module


def _write(path: Path, content: str) -> Path:
    path.write_text(content, encoding="utf-8")
    return path


def test_loads_simple_module_and_exposes_attributes(tmp_path: Path) -> None:
    file = _write(tmp_path / "simple_mod.py", "GREETING = 'hello'\n\ndef shout():\n    return GREETING.upper()\n")
    mod = import_module_file(file)
    assert mod.GREETING == "hello"
    assert mod.shout() == "HELLO"


def test_accepts_str_path(tmp_path: Path) -> None:
    file = _write(tmp_path / "as_str.py", "VALUE = 42\n")
    mod = import_module_file(str(file))
    assert mod.VALUE == 42


def test_accepts_relative_path_by_resolving(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    _write(tmp_path / "relative_mod.py", "VALUE = 'rel'\n")
    mod = import_module_file(Path("relative_mod.py"))
    assert mod.VALUE == "rel"


def test_different_files_with_same_stem_do_not_collide(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    a = _write(tmp_path / "a" / "schema.py", "NAME = 'a'\n")
    b = _write(tmp_path / "b" / "schema.py", "NAME = 'b'\n")
    mod_a = import_module_file(a)
    mod_b = import_module_file(b)
    assert mod_a.NAME == "a"
    assert mod_b.NAME == "b"


def test_module_can_import_stdlib(tmp_path: Path) -> None:
    file = _write(
        tmp_path / "uses_stdlib.py",
        "from pathlib import Path as _P\n\nCWD = str(_P.cwd())\n",
    )
    mod = import_module_file(file)
    assert isinstance(mod.CWD, str)


def test_raises_module_load_error_for_missing_file(tmp_path: Path) -> None:
    with pytest.raises((ModuleLoadError, FileNotFoundError)):
        import_module_file(tmp_path / "does_not_exist.py")


def test_propagates_user_module_exceptions(tmp_path: Path) -> None:
    file = _write(tmp_path / "boom.py", "raise ValueError('oops')\n")
    with pytest.raises(ValueError, match="oops"):
        import_module_file(file)


def test_reexport_from_top_level_matches_module() -> None:
    assert import_module_file is import_from_module
