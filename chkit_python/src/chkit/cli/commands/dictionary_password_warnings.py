"""Detect plain-text dictionary passwords in a migration plan.

1:1 port of ``packages/cli/src/commands/generate/dictionary-password-warnings.ts``.
"""

from __future__ import annotations

import re
from typing import Final

from chkit.core.model import MigrationPlan

_PASSWORD_LITERAL_RE: Final[re.Pattern[str]] = re.compile(
    r"password\s+'(?!\[HIDDEN\])(?:[^'\\]|\\.)*'", re.IGNORECASE
)

_DICTIONARY_KEY_PREFIX = "dictionary:"


def detect_dictionary_password_warnings(plan: MigrationPlan) -> list[str]:
    return [
        (
            f'Dictionary "{op.key[len(_DICTIONARY_KEY_PREFIX):]}" has a password in '
            f"its SOURCE(...) — it will be written in plain text to the generated "
            f"migration SQL file."
        )
        for op in plan.operations
        if op.type == "create_dictionary" and _PASSWORD_LITERAL_RE.search(op.sql)
    ]
