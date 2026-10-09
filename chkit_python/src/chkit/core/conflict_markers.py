"""Detect unresolved git merge conflict markers.

Mirrors ``@chkit/core/conflict-markers.ts``.
"""

from __future__ import annotations

import re
from typing import Final

# Git writes conflict markers at the start of a line: `<<<<<<< ours`, `=======`,
# `>>>>>>> theirs`, and `||||||| base` with diff3/zdiff3. `conflict-marker-size`
# can make them longer than 7 characters.
_CONFLICT_MARKER_LINE: Final[re.Pattern[str]] = re.compile(
    r"^(?:<{7,}|>{7,}|\|{7,})(?:[ \t].*)?$|^={7,}[ \t]*$"
)
_LINE_BREAK: Final[re.Pattern[str]] = re.compile(r"\r?\n")


def has_conflict_markers(text: str) -> bool:
    """Whether ``text`` has a line that git writes for an unresolved merge conflict."""
    return any(_CONFLICT_MARKER_LINE.fullmatch(line) for line in _LINE_BREAK.split(text))
