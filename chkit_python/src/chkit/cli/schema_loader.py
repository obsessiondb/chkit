"""Discover and load user schema modules into a list of definitions.

Thin CLI-layer wrapper around ``chkit.core.schema_loader.load_schema_definitions``.
Kept around for backwards compatibility with the rest of the CLI; new code
should prefer the core module directly.
"""

from __future__ import annotations

from chkit.core.model import SchemaDefinition
from chkit.core.schema_loader import load_schema_definitions


def load_schema(patterns: list[str]) -> list[SchemaDefinition]:
    """Walk schema modules and collect exported ``SchemaDefinition`` objects."""
    return load_schema_definitions(patterns)
