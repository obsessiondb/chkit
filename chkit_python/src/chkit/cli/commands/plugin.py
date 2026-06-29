"""`chkit plugin [<name> [<command>]]` — list configured plugins / dispatch commands.

1:1 port of the user-facing surface of ``packages/cli/src/commands/plugin.ts``.

Usage:

    chkit plugin                     # list every configured plugin + its commands
    chkit plugin <name>              # list commands registered by one plugin
    chkit plugin <name> <command>    # dispatch the plugin command (with --args)
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from chkit.cli.config_loader import load_config
from chkit.cli.plugin_runtime import (
    load_plugin_runtime,
    make_plugin_context,
    null_plugin_context,
)
from chkit.cli.table_scope import TableScope
from chkit.clickhouse.client import ClickHouseClient
from chkit.plugins import (
    ChxPlugin,
    ChxPluginCommandContext,
    LoadedPlugin,
)


def _list_all(loaded: list[LoadedPlugin]) -> None:
    if not loaded:
        typer.echo("No plugins configured.")
        return
    typer.echo(f"{len(loaded)} plugin(s) configured:")
    for entry in loaded:
        manifest = entry.plugin.manifest
        version = f" v{manifest.version}" if manifest.version else ""
        typer.echo(f"- {manifest.name}{version}")
        for command in entry.plugin.commands or []:
            description = (
                f"  ({command.description})" if command.description else ""
            )
            typer.echo(f"    {manifest.name} {command.name}{description}")


def _list_one(entry: LoadedPlugin) -> None:
    typer.echo(f"Plugin: {entry.plugin.manifest.name}")
    commands = entry.plugin.commands or []
    if not commands:
        typer.echo("  (no commands registered)")
        return
    for command in commands:
        description = f" — {command.description}" if command.description else ""
        typer.echo(f"  {command.name}{description}")


def run(
    plugin_name: Annotated[
        str | None,
        typer.Argument(help="Plugin name to inspect or dispatch."),
    ] = None,
    command_name: Annotated[
        str | None,
        typer.Argument(help="Command name within the plugin."),
    ] = None,
    args: Annotated[
        list[str] | None,
        typer.Argument(help="Positional arguments forwarded to the plugin command."),
    ] = None,
    config_path: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to clickhouse.config.py."),
    ] = None,
    output_json: Annotated[
        bool,
        typer.Option(
            "--json", help="Emit the plugin command's print payload as JSON."
        ),
    ] = False,
) -> None:
    config = load_config(config_path)
    runtime = load_plugin_runtime(
        [p for p in config.plugins if isinstance(p, ChxPlugin)]
    )
    loaded = list(runtime.plugins)

    if plugin_name is None:
        _list_all(loaded)
        return

    entry = next(
        (e for e in loaded if e.plugin.manifest.name == plugin_name), None
    )
    if entry is None:
        msg = (
            f'No plugin named "{plugin_name}" is configured. '
            f"Run `chkit plugin` to see registered plugins."
        )
        raise typer.BadParameter(msg)

    if command_name is None:
        _list_one(entry)
        return

    found = runtime.get_command(plugin_name, command_name)
    if found is None:
        msg = (
            f'Plugin "{plugin_name}" has no command "{command_name}". '
            f"Run `chkit plugin {plugin_name}` to see its commands."
        )
        raise typer.BadParameter(msg)

    # Connect lazily — some plugin commands don't need a DB.
    plugin_context = null_plugin_context()
    cm = (
        ClickHouseClient.connect(config.clickhouse)
        if config.clickhouse is not None
        else None
    )
    try:
        if cm is not None:
            plugin_context = make_plugin_context(cm)
        ctx = ChxPluginCommandContext(
            plugin_name=plugin_name,
            config=config,
            config_path=str(config_path or "clickhouse.config.py"),
            json_mode=output_json,
            args=list(args or []),
            flags={},
            options={},
            raw_options={},
            table_scope=TableScope(enabled=False),
            print=typer.echo,
            plugin_runtime=runtime,
            plugin_context=plugin_context,
        )
        exit_code = runtime.run_plugin_command(plugin_name, command_name, ctx)
    finally:
        if cm is not None:
            cm.close()

    if exit_code != 0:
        raise typer.Exit(code=exit_code)
