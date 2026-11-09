"""``chkit codegen`` — top-level shortcut for ``chkit plugin codegen codegen``.

Mirrors the TS CLI, where ``chkit codegen`` is a first-class command that
dispatches to the registered codegen plugin. Flags are forwarded to the
plugin command (``--check``, ``--out-file``, ``--bigint-mode``,
``--include-views``, ``--table-name-style``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.commands.plugin import dispatch_plugin_command


def run(
    args: Annotated[
        list[str] | None,
        typer.Argument(
            help=(
                "Flags forwarded to the codegen plugin command, e.g. "
                "--check, --out-file <path>, --bigint-mode <mode>."
            )
        ),
    ] = None,
    # A str, not a Path: the command gets the raw value in its flags, as in TS.
    config_path: Annotated[
        str | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    output_json: Annotated[
        bool,
        typer.Option("--json", help="Emit a JSON-formatted summary."),
    ] = False,
) -> None:
    dispatch_plugin_command(
        plugin_name="codegen",
        command_name="codegen",
        tokens=list(args or []),
        config_path=Path(config_path) if config_path is not None else None,
        output_json=output_json,
        invoking_command="codegen",
        config_flag=config_path,
    )
