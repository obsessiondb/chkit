"""The parsed-flag dict a command hands its plugin hooks, in the TS shape.

The TS CLI passes every hook the flags its parser saw on the command line,
keyed by long name (``--json``, ``--table``): a boolean flag as ``True``, a
string flag as its value. Typer gives every option its default instead, so a
command lists its options here and only the ones that were passed are kept.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def passed_flags(values: Mapping[str, Any]) -> dict[str, Any]:
    """Drop the options left at their ``False`` / ``None`` default."""
    return {
        name: value for name, value in values.items() if value is not None and value is not False
    }
