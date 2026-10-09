"""Parse `-- key: value` header comments from migration SQL.

1:1 port of ``packages/cli/src/runtime/migration-metadata.ts``.

Only the leading run of comment lines is scanned; the first non-comment
non-empty line terminates parsing. Unknown keys are ignored. A key
appearing twice keeps the first occurrence (matches TS behaviour where
``meta[key] !== undefined`` short-circuits).

Currently the only recognised key is ``log``, surfaced during ``migrate``
to display a per-migration narration line. New keys land here when the
TS side adds them — keep ``KNOWN_KEYS`` in sync.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_META_LINE = re.compile(r"^--\s*([a-zA-Z][a-zA-Z0-9-]*)\s*:\s*(.+)$")

KNOWN_KEYS: frozenset[str] = frozenset({"log"})


@dataclass(frozen=True, slots=True)
class MigrationMetadata:
    log: str | None = None


def extract_migration_metadata(sql: str) -> MigrationMetadata:
    """Walk leading comment lines, harvest recognised ``-- key: value`` pairs."""
    collected: dict[str, str] = {}
    for raw_line in sql.split("\n"):
        line = raw_line.strip()
        if line == "":
            continue
        if not line.startswith("--"):
            break
        match = _META_LINE.match(line)
        if match is None:
            continue
        key = match.group(1).lower()
        value = match.group(2).strip()
        if not key or not value:
            continue
        if key not in KNOWN_KEYS:
            continue
        # First occurrence wins.
        if key in collected:
            continue
        collected[key] = value
    return MigrationMetadata(log=collected.get("log"))
