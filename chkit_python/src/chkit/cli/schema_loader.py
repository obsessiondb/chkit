"""Discover and load user schema modules into a list of definitions."""

from __future__ import annotations

import glob
import importlib.util
import sys
from pathlib import Path
from typing import Any

from chkit.core.model import (
    MaterializedViewDefinition,
    SchemaDefinition,
    TableDefinition,
    ViewDefinition,
)


def _discover_paths(patterns: list[str]) -> list[Path]:
    found: list[Path] = []
    seen: set[str] = set()
    for pattern in patterns:
        for match in glob.glob(pattern, recursive=True):
            absolute = str(Path(match).resolve())
            if absolute in seen:
                continue
            seen.add(absolute)
            found.append(Path(absolute))
    return sorted(found)


def _load_module(path: Path) -> Any:
    name = f"chkit_schema_{path.stem}_{abs(hash(str(path)))}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        msg = f"Unable to load schema module {path}"
        raise RuntimeError(msg)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _collect(value: object, out: list[SchemaDefinition]) -> None:
    if isinstance(value, TableDefinition | ViewDefinition | MaterializedViewDefinition):
        out.append(value)
        return
    if isinstance(value, list | tuple):
        for entry in value:
            _collect(entry, out)


def load_schema(patterns: list[str]) -> list[SchemaDefinition]:
    """Walk schema modules and collect exported ``SchemaDefinition`` objects."""
    paths = _discover_paths(patterns)
    out: list[SchemaDefinition] = []
    for path in paths:
        module = _load_module(path)
        for value in vars(module).values():
            _collect(value, out)
    return out
