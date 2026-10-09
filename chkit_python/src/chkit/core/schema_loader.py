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
from types import ModuleType

from chkit.core.canonical import canonicalize_definitions
from chkit.core.conflict_markers import has_conflict_markers
from chkit.core.model import SchemaDefinition, collect_definitions_from_module
from chkit.core.ts_import import import_module_file

NO_MATCH_MESSAGE = "No schema files matched. Check config.schema patterns."


class SchemaLoaderError(RuntimeError):
    """Raised when schema globs match nothing."""


class SchemaFileLoadError(RuntimeError):
    """Raised when a matched schema file fails to import.

    The message names the file and the parser position, and says which file
    holds git conflict markers when they caused the failure.
    """


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
        module = _import_schema_file(file)
        collected.extend(collect_definitions_from_module(vars(module)))

    return canonicalize_definitions(collected)


def _import_schema_file(file: Path) -> ModuleType:
    """Import one schema file. A failure names the file, and points out git conflict markers."""
    try:
        return import_module_file(file)
    except Exception as error:
        raise SchemaFileLoadError(_describe_import_failure(file, error)) from error


def _describe_import_failure(file: Path, error: Exception) -> str:
    summary = f"Failed to load schema file {file}: {_describe_error(error)}"
    # The parser names the file that failed to parse, which can be a module the
    # schema file imports.
    candidates = [str(file)]
    if isinstance(error, SyntaxError) and error.filename:
        candidates.append(error.filename)
    conflicted = _find_conflicted_file(candidates)
    if conflicted is None:
        return summary
    holder = "The file" if conflicted == str(file) else conflicted
    return (
        f"{summary}\n{holder} contains unresolved merge conflict markers. "
        "Resolve the conflict and run the command again."
    )


def _find_conflicted_file(files: list[str]) -> str | None:
    for candidate in dict.fromkeys(files):
        try:
            text = Path(candidate).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if has_conflict_markers(text):
            return candidate
    return None


def _describe_error(error: Exception) -> str:
    """``<Type>: <message>``, plus ``(<file>:<line>:<column>)`` for a parse error."""
    if isinstance(error, SyntaxError):
        position = (
            f" ({error.filename}:{error.lineno}:{error.offset})" if error.filename else ""
        )
        return f"{type(error).__name__}: {error.msg}{position}"
    message = str(error)
    return f"{type(error).__name__}: {message}" if message else type(error).__name__
