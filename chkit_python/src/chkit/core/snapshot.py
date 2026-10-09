"""Snapshot creation."""

from __future__ import annotations

from datetime import UTC, datetime

from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import SchemaDefinition, SnapshotV1


def create_snapshot(definitions: list[SchemaDefinition]) -> SnapshotV1:
    canonical = canonicalize_definitions(definitions)
    return SnapshotV1.model_validate(
        {
            "version": 1,
            "generatedAt": datetime.now(tz=UTC).isoformat(),
            "definitions": [d.model_dump(by_alias=True) for d in canonical],
        }
    )
