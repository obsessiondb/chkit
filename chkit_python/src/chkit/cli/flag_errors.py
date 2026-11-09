"""Report a usage error the way the TS CLI does (#563)."""

from __future__ import annotations

from collections.abc import Callable
from typing import NoReturn

import typer

from chkit.cli.json_output import emit_json, emit_json_error


def report_usage_error(
    command: str,
    message: str,
    *,
    json_mode: bool,
    code: str = "usage",
    on_text: Callable[[], None] | None = None,
) -> NoReturn:
    """Print ``message`` on stderr and, under ``--json``, an error envelope
    with ``code`` on stdout (otherwise run ``on_text``, when given), then exit
    1 (``reportUsageError`` in ``packages/cli/src/bin/chkit.ts``)."""
    typer.echo(message, err=True)
    if json_mode:
        emit_json_error(command, {"code": code, "message": message})
    elif on_text is not None:
        on_text()
    raise typer.Exit(code=1)


def report_flag_error(command: str, message: str, *, json_mode: bool) -> NoReturn:
    """Print ``message`` on stderr and, under ``--json``, a ``usage`` error
    envelope on stdout, then exit 1 (``parseFlagsOrReport`` in
    ``packages/cli/src/runtime/command-dispatch.ts``).

    ``chkit plugin <name> <command>`` keeps its string error, as in
    ``packages/cli/src/commands/plugin.ts``: under ``--json`` the envelope
    ``{ok: false, error: message}`` replaces the stderr line.
    """
    if command == "plugin" and json_mode:
        emit_json("plugin", {"ok": False, "error": message})
        raise typer.Exit(code=1)
    report_usage_error(command, message, json_mode=json_mode)
