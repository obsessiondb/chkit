"""Report an unknown flag or a missing flag value the way the TS CLI does (#563)."""

from __future__ import annotations

from typing import NoReturn

import typer

from chkit.cli.json_output import emit_json, emit_json_error


def report_flag_error(
    command: str, message: str, *, json_mode: bool, global_flag: bool = False
) -> NoReturn:
    """Print ``message`` on stderr and, under ``--json``, a ``usage`` error
    envelope on stdout, then exit 1 (``parseFlagsOrReport`` in
    ``packages/cli/src/runtime/command-dispatch.ts``).

    ``chkit plugin <name> <command>`` keeps its string error, as in
    ``packages/cli/src/commands/plugin.ts``: under ``--json`` the envelope
    ``{ok: false, error: message}`` replaces the stderr line. A
    ``global_flag`` error (a missing ``--config`` value) is reported before
    dispatch in TS (``extractConfigPath`` in ``bin/chkit.ts``), so it gets the
    ``usage`` envelope under ``plugin`` too.
    """
    if command == "plugin" and json_mode and not global_flag:
        emit_json("plugin", {"ok": False, "error": message})
    else:
        typer.echo(message, err=True)
        if json_mode:
            emit_json_error(command, {"code": "usage", "message": message})
    raise typer.Exit(code=1)
