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
    config_path: Annotated[
        Path | None,
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
        config_path=config_path,
        output_json=output_json,
        invoking_command="codegen",
    )
