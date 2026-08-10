"""`chkit plugin [<name> [<command>]]` — list configured plugins / dispatch commands.

1:1 port of the user-facing surface of ``packages/cli/src/commands/plugin.ts``.

Usage:

    chkit plugin                     # list every configured plugin + its commands
    chkit plugin <name>              # list commands registered by one plugin
    chkit plugin <name> <command>    # dispatch the plugin command (with --args)
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, cast

import typer

from chkit.cli.config_loader import load_config
from chkit.cli.json_output import print_output
from chkit.cli.plugin_runtime import (
    load_plugin_runtime,
    make_plugin_context,
    null_plugin_context,
)
from chkit.cli.table_scope import TableScope
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.flags import (
    FlagDef,
    MissingFlagValueError,
    ParsedFlags,
    UnknownFlagError,
    parse_flags,
)
from chkit.core.model import ChxConfigEnv
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


def _split_positionals_and_flags(
    tokens: list[str], flag_defs: list[dict[str, Any]]
) -> tuple[list[str], ParsedFlags]:
    """Separate forwarded tokens into positionals and parsed option flags.

    Mirrors the TS dispatcher: option tokens are validated against the plugin
    command's declared flags (unknown ``--flags`` error out via
    ``UnknownFlagError``), everything else stays positional.
    """
    allowed = {"name", "type", "description", "placeholder", "negation"}
    defs = [
        cast("FlagDef", {k: v for k, v in entry.items() if k in allowed})
        for entry in flag_defs
    ]
    flags = parse_flags(tokens, defs)

    lookup = {d["name"]: d for d in defs}
    positionals: list[str] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token.startswith("--"):
            name = token.split("=", 1)[0]
            definition = lookup.get(name)
            consumes_value = (
                definition is not None
                and definition["type"] != "boolean"
                and "=" not in token
            )
            i += 2 if consumes_value else 1
            continue
        positionals.append(token)
        i += 1
    return positionals, flags


def _extended_flag_defs(
    runtime: Any, plugin_name: str
) -> list[dict[str, Any]]:
    """Flags other plugins register against this command (TS ``extendCommands``,
    e.g. obsessiondb adding --local/--job-id to the backfill commands)."""
    extended: list[dict[str, Any]] = []
    for entry in runtime.plugins:
        for extension in entry.plugin.extend_commands or []:
            targets = extension.get("command")
            if isinstance(targets, list) and plugin_name in targets:
                extended.extend(extension.get("flags") or [])
    return extended


def dispatch_plugin_command(
    *,
    plugin_name: str,
    command_name: str,
    tokens: list[str],
    config_path: Path | None,
    output_json: bool,
    invoking_command: str = "plugin",
    extra_flags: ParsedFlags | None = None,
) -> None:
    """Load config + plugins, parse forwarded flags, run one plugin command.

    Shared by ``chkit plugin <name> <cmd>`` and the top-level shortcuts
    (``chkit codegen``, ``chkit obsessiondb ...``), mirroring the TS CLI.
    """
    config = load_config(config_path, ChxConfigEnv(command=invoking_command))
    runtime = load_plugin_runtime(
        [p for p in config.plugins if isinstance(p, ChxPlugin)]
    )

    entry = next(
        (e for e in runtime.plugins if e.plugin.manifest.name == plugin_name), None
    )
    if entry is None:
        msg = (
            f'No plugin named "{plugin_name}" is configured. '
            f"Run `chkit plugin` to see registered plugins."
        )
        raise typer.BadParameter(msg)

    found = runtime.get_command(plugin_name, command_name)
    if found is None:
        msg = (
            f'Plugin "{plugin_name}" has no command "{command_name}". '
            f"Run `chkit plugin {plugin_name}` to see its commands."
        )
        raise typer.BadParameter(msg)

    command_def, _command_owner = found
    flag_defs = list(command_def.flags or [])
    flag_defs.extend(_extended_flag_defs(runtime, plugin_name))
    try:
        positionals, flags = _split_positionals_and_flags(tokens, flag_defs)
    except (UnknownFlagError, MissingFlagValueError) as error:
        raise typer.BadParameter(str(error)) from error
    if extra_flags:
        flags.update(extra_flags)

    # Connect opportunistically — some plugin commands don't need a DB
    # (codegen, backfill status, ...). Mirroring TS, an unreachable
    # ClickHouse must not block those: fall back to a null context and let
    # commands that genuinely need an executor report it themselves.
    plugin_context = null_plugin_context()
    cm = None
    if config.clickhouse is not None:
        try:
            cm = ClickHouseClient.connect(config.clickhouse)
        except Exception:
            cm = None
    try:
        if cm is not None:
            plugin_context = make_plugin_context(cm)
        ctx = ChxPluginCommandContext(
            plugin_name=plugin_name,
            config=config,
            config_path=str(config_path or "clickhouse.config.py"),
            json_mode=output_json,
            args=positionals,
            flags=dict(flags),
            options={},
            raw_options={},
            table_scope=TableScope(enabled=False),
            # TS routes plugin prints through printOutput: --json emits real
            # JSON (bare strings wrapped in {schemaVersion, message}); plain
            # mode prints strings only.
            print=lambda value: print_output(value, json_mode=output_json),
            plugin_runtime=runtime,
            plugin_context=plugin_context,
        )
        exit_code = runtime.run_plugin_command(plugin_name, command_name, ctx)
    finally:
        if cm is not None:
            cm.close()

    if exit_code != 0:
        raise typer.Exit(code=exit_code)


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
        typer.Argument(
            help=(
                "Arguments forwarded to the plugin command — positionals and "
                "the command's own --flags."
            )
        ),
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
    if plugin_name is None or command_name is None:
        config = load_config(config_path, ChxConfigEnv(command="plugin"))
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
        _list_one(entry)
        return

    dispatch_plugin_command(
        plugin_name=plugin_name,
        command_name=command_name,
        tokens=list(args or []),
        config_path=config_path,
        output_json=output_json,
    )
