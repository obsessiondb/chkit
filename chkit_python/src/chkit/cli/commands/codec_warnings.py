"""Warn about experimental codecs in a migration plan.

1:1 port of ``packages/cli/src/commands/generate/codec-warnings.ts``.
"""

from __future__ import annotations

import re
from typing import Final

from chkit.core.model import MigrationPlan

# `CODEC(...)` holding ALP, through one level of nested arguments (`Delta(8)`).
_ALP_CODEC_RE: Final[re.Pattern[str]] = re.compile(r"\bCODEC\((?:[^()]|\([^()]*\))*\bALP\b")


def detect_experimental_codec_warnings(plan: MigrationPlan) -> list[str]:
    """ClickHouse rejects the experimental ALP codec unless ``allow_experimental_codecs``
    is set (#465)."""
    return [
        (
            f"{op.key} uses the experimental ALP codec, which ClickHouse rejects unless "
            "allow_experimental_codecs is 1. Apply it with chkit migrate --apply "
            "--setting allow_experimental_codecs=1."
        )
        for op in plan.operations
        if _ALP_CODEC_RE.search(op.sql)
    ]
