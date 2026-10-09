"""Parse ``snapshot.json`` text and diff snapshot definitions.

1:1 port of ``packages/cli/src/runtime/snapshot-document.ts``. Text that is not
JSON is classified instead of raised, so callers can tell an unresolved git
merge conflict from other damage.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal, TypeAlias, cast

from chkit.core.canonical import canonicalize_definitions, definition_key
from chkit.core.conflict_markers import has_conflict_markers
from chkit.core.model import SchemaDefinition, Snapshot

SnapshotUnreadableReason: TypeAlias = Literal["empty", "conflict_markers", "invalid_json"]


@dataclass(frozen=True, slots=True)
class ReadableSnapshotDocument:
    snapshot: Snapshot
    status: Literal["ok"] = "ok"


@dataclass(frozen=True, slots=True)
class UnreadableSnapshotDocument:
    reason: SnapshotUnreadableReason
    status: Literal["unreadable"] = "unreadable"


ParsedSnapshotDocument: TypeAlias = ReadableSnapshotDocument | UnreadableSnapshotDocument


@dataclass(frozen=True, slots=True)
class SnapshotDiff:
    """Definition keys (``kind:database.name``) that differ between two lists."""

    #: Keys only in ``next``, in ``next`` order.
    added: list[str] = field(default_factory=list[str])
    #: Keys only in ``previous``, in ``previous`` order.
    removed: list[str] = field(default_factory=list[str])
    #: Keys in both lists whose entries differ, in ``next`` order.
    changed: list[str] = field(default_factory=list[str])


def parse_snapshot_document(raw: str) -> ParsedSnapshotDocument:
    """Parse the text of a ``snapshot.json``.

    JSON is read as leniently as before: missing fields default and definitions
    are canonicalized. Entries chkit never writes may still raise.
    """
    if raw.strip() == "":
        return UnreadableSnapshotDocument(reason="empty")

    try:
        parsed: Any = json.loads(raw)
    except ValueError:
        # A marker line is never valid JSON, so this check only runs on text that
        # already failed to parse and cannot misread a valid snapshot.
        reason: SnapshotUnreadableReason = (
            "conflict_markers" if has_conflict_markers(raw) else "invalid_json"
        )
        return UnreadableSnapshotDocument(reason=reason)

    if parsed is None:
        msg = "Snapshot JSON is null"
        raise TypeError(msg)
    fields = cast("dict[str, Any]", parsed) if isinstance(parsed, dict) else {}
    generated_at = fields.get("generatedAt")
    definitions = fields.get("definitions")
    snapshot = Snapshot.model_validate(
        {
            "version": 1,
            "generatedAt": "" if generated_at is None else generated_at,
            "definitions": [] if definitions is None else definitions,
        }
    )
    canonical = canonicalize_definitions(snapshot.definitions)
    return ReadableSnapshotDocument(
        snapshot=snapshot.model_copy(update={"definitions": canonical})
    )


def diff_snapshot_definitions(
    previous: list[SchemaDefinition], next_definitions: list[SchemaDefinition]
) -> SnapshotDiff:
    """Compare two canonical definition lists entry by entry.

    Entries are equal when their JSON is equal regardless of object key order;
    ``None`` values count as absent, as they do in the written file.
    ``generatedAt`` is not part of the comparison.
    """
    previous_by_key = {definition_key(d): _fingerprint(d) for d in previous}
    next_keys = {definition_key(d) for d in next_definitions}

    added: list[str] = []
    changed: list[str] = []
    for definition in next_definitions:
        key = definition_key(definition)
        before = previous_by_key.get(key)
        if before is None:
            added.append(key)
        elif before != _fingerprint(definition):
            changed.append(key)
    removed = [key for key in previous_by_key if key not in next_keys]

    return SnapshotDiff(added=added, removed=removed, changed=changed)


def _fingerprint(definition: SchemaDefinition) -> str:
    # Same projection the snapshot writer uses (exclude_none mirrors JSON.stringify
    # dropping undefined). sort_keys sorts every nested object; arrays keep their
    # order because column and key order is meaningful.
    payload = definition.model_dump(mode="json", by_alias=True, exclude_none=True)
    return json.dumps(payload, sort_keys=True)
