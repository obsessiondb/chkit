"""Interactive prompts for ``chkit migrate``.

1:1 port of ``packages/cli/src/commands/migrate/prompts.ts``.

- ``is_background_or_ci()`` — auto-skip prompts in CI / non-TTY runs.
- ``confirm_apply()`` — "Apply pending migrations now? [no/yes]:" prompt.
- ``confirm_destructive_execution(markers)`` — prints per-op details and
  asks "Apply destructive operations? [no/yes]:".
- ``print_destructive_operation_details(markers)`` — pure printer used by
  the prompt and by ``migrate.py`` in non-interactive runs.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Sequence

from chkit.cli.safety_markers import DestructiveOperationMarker


def is_background_or_ci() -> bool:
    """Return True when input or output is not attached to a TTY, or CI is set.

    Mirrors the TS rule: ``CI=1`` / ``CI=true`` OR ``!stdin.isTTY`` OR
    ``!stdout.isTTY``. Any of these conditions makes ``chkit migrate`` skip
    interactive prompts and behave like a batch tool.
    """
    if os.environ.get("CI") in {"1", "true"}:
        return True
    stdin_tty = getattr(sys.stdin, "isatty", lambda: False)()
    stdout_tty = getattr(sys.stdout, "isatty", lambda: False)()
    return not stdin_tty or not stdout_tty


def _prompt_yes(message: str) -> bool:
    """Print a "type yes" notice and read a single line from stdin."""
    print()
    print('Type "yes" to continue. Any other input cancels.')
    try:
        response = input(message)
    except EOFError:
        return False
    return response.strip().lower() == "yes"


def confirm_apply() -> bool:
    """Prompt the user before applying pending migrations."""
    return _prompt_yes("Apply pending migrations now? [no/yes]: ")


def print_destructive_operation_details(
    markers: Sequence[DestructiveOperationMarker],
) -> None:
    """Echo a per-marker summary block (used by prompt + non-interactive log)."""
    print("Destructive operations detected:")
    for index, marker in enumerate(markers, start=1):
        print(f"{index}. {marker.migration}")
        print(f"   operation: {marker.type}")
        print(f"   key: {marker.key}")
        print(f"   warning: {marker.warning_code}")
        print(f"   reason: {marker.reason}")
        print(f"   impact: {marker.impact}")
        print(f"   recommendation: {marker.recommendation}")


def confirm_destructive_execution(
    markers: Sequence[DestructiveOperationMarker],
) -> bool:
    """Print the danger summary then ask the user to confirm."""
    print_destructive_operation_details(markers)
    return _prompt_yes("Apply destructive operations? [no/yes]: ")
