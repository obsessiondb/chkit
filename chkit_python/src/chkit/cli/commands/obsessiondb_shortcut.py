"""``chkit obsessiondb <command>`` — top-level shortcut for the ObsessionDB plugin.

Mirrors the TS CLI, where ``chkit obsessiondb login`` / ``service select`` /
``whoami`` etc. are first-class. Dispatches to the registered ``obsessiondb``
plugin command of the same name, forwarding positionals and flags — so
multi-word commands work naturally: ``chkit obsessiondb service select``
dispatches the plugin's ``service`` command with ``select`` as a positional.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.commands.plugin import dispatch_plugin_command


def run(
    command_name: Annotated[
        str,
        typer.Argument(help="ObsessionDB command (login, signup, whoami, service, ...)."),
    ],
    args: Annotated[
        list[str] | None,
        typer.Argument(
            help="Arguments and flags forwarded to the ObsessionDB command."
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
        plugin_name="obsessiondb",
        command_name=command_name,
        tokens=list(args or []),
        config_path=config_path,
        output_json=output_json,
        invoking_command="obsessiondb",
    )
