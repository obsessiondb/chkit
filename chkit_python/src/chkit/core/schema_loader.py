"""Discover schema modules via glob, import them, and collect SchemaDefinitions.

Generic schema loader exposed from ``@chkit/core`` to mirror the
TypeScript surface. The CLI also has a thin wrapper but this is the
canonical entry point so plugins and tests can call it directly.

Mirrors `@chkit/core/schema-loader.ts.loadSchemaDefinitions`.
"""

from __future__ import annotations

import glob
import os
from pathlib import Path

from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import SchemaDefinition, collect_definitions_from_module
from chkit.core.ts_import import import_module_file

NO_MATCH_MESSAGE = "No schema files matched. Check config.schema patterns."


class SchemaLoaderError(RuntimeError):
    """Raised when schema globs match nothing."""


def _discover(patterns: list[str], cwd: Path) -> list[Path]:
    found: list[Path] = []
    seen: set[str] = set()
    for pattern in patterns:
        target = pattern if os.path.isabs(pattern) else str(cwd / pattern)
        for match in glob.glob(target, recursive=True):
            absolute = str(Path(match).resolve())
            if absolute in seen:
                continue
            seen.add(absolute)
            found.append(Path(absolute))
    return sorted(found)


def load_schema_definitions(
    schema_globs: str | list[str],
    *,
    cwd: Path | str | None = None,
) -> list[SchemaDefinition]:
    """Resolve schema globs, import each match, return canonicalized definitions.

    Args:
        schema_globs: Single glob or list of globs. Relative patterns are
            anchored to ``cwd``. Supports ``**`` recursion.
        cwd: Working directory for relative globs. Defaults to the process
            current working directory.

    Returns:
        Canonicalized list of SchemaDefinition objects (tables, views,
        materialized views) collected from every matched module.

    Raises:
        SchemaLoaderError: If no files matched the supplied globs.
    """
    patterns = [schema_globs] if isinstance(schema_globs, str) else list(schema_globs)
    base = Path(cwd) if cwd is not None else Path.cwd()

    files = _discover(patterns, base)
    if not files:
        raise SchemaLoaderError(NO_MATCH_MESSAGE)

    collected: list[SchemaDefinition] = []
    for file in files:
        module = import_module_file(file)
        collected.extend(collect_definitions_from_module(vars(module)))

    return canonicalize_definitions(collected)
