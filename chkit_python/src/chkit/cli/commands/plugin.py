"""`chkit plugin [<name> [<command>]]` — list configured plugins / dispatch commands.

1:1 port of the user-facing surface of ``packages/cli/src/commands/plugin.ts``.

Usage:

    chkit plugin                     # list every configured plugin + its commands
    chkit plugin <name>              # list commands registered by one plugin
    chkit plugin <name> <command>    # dispatch the plugin command (with --args)
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, NoReturn, cast

import typer

from chkit.cli.config_loader import load_config, loaded_config_path
from chkit.cli.flag_errors import report_flag_error, report_usage_error
from chkit.cli.json_output import emit_json, print_output
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
    expand_short_flags,
    parse_flags,
)
from chkit.core.model import ChxConfigEnv
from chkit.plugins import (
    ChxPlugin,
    ChxPluginCommandContext,
    LoadedPlugin,
)

NO_PLUGINS_MESSAGE = "No plugins configured. Add entries to config.plugins first."

class UnknownPluginError(LookupError):
    """No configured plugin has the name. As in TS, a plain error of the
    command: its message on stderr, exit 1 and the ``error`` envelope under
    ``--json``."""


def _unknown_plugin_error(plugin_name: str, loaded: list[LoadedPlugin]) -> UnknownPluginError:
    known = sorted(entry.plugin.manifest.name for entry in loaded)
    return UnknownPluginError(
        f'Unknown plugin "{plugin_name}". Available: {", ".join(known) or "(none)"}.'
    )


def _fail_no_plugins(*, json_mode: bool) -> NoReturn:
    """As TS: the message on stderr, or under ``--json`` a payload whose
    ``error`` is the message; exit 1 either way."""
    if json_mode:
        emit_json("plugin", {"error": NO_PLUGINS_MESSAGE, "plugins": []})
    else:
        typer.echo(NO_PLUGINS_MESSAGE, err=True)
    raise typer.Exit(code=1)


def _command_entries(entry: LoadedPlugin) -> list[dict[str, str]]:
    return [
        {"name": command.name, "description": command.description or ""}
        for command in entry.plugin.commands or []
    ]


def _list_all(loaded: list[LoadedPlugin], *, json_mode: bool) -> None:
    if json_mode:
        plugins = [
            {
                "name": entry.plugin.manifest.name,
                "version": entry.plugin.manifest.version,
                "commands": _command_entries(entry),
            }
            for entry in loaded
        ]
        emit_json("plugin", {"plugins": plugins})
        return
    typer.echo("Configured plugins:")
    for entry in loaded:
        manifest = entry.plugin.manifest
        version = f" (v{manifest.version})" if manifest.version else ""
        typer.echo(f"- {manifest.name}{version}")
        commands = _command_entries(entry)
        if not commands:
            typer.echo("  (no commands)")
            continue
        for command in commands:
            description = f": {command['description']}" if command["description"] else ""
            typer.echo(f"  - {command['name']}{description}")


def _list_one(entry: LoadedPlugin, *, json_mode: bool) -> None:
    name = entry.plugin.manifest.name
    commands = _command_entries(entry)
    if json_mode:
        emit_json("plugin", {"plugin": name, "commands": commands})
        return
    if not commands:
        typer.echo(f'Plugin "{name}" has no registered commands.')
        return
    typer.echo(f'Plugin commands for "{name}":')
    for command in commands:
        description = f": {command['description']}" if command["description"] else ""
        typer.echo(f"- {command['name']}{description}")


def _split_positionals_and_flags(
    tokens: list[str], flag_defs: list[dict[str, Any]]
) -> tuple[list[str], ParsedFlags]:
    """Separate forwarded tokens into positionals and parsed option flags.

    Mirrors the TS dispatcher: option tokens are validated against the plugin
    command's declared flags (unknown ``--flags`` error out via
    ``UnknownFlagError``), everything else stays positional. A flag never
    takes ``--`` as its value, so the first one ends the flags: every token
    after it is a positional as is, even when it starts with ``-`` (#568).
    """
    allowed = {"name", "type", "description", "placeholder", "negation", "short"}
    defs = [
        cast("FlagDef", {k: v for k, v in entry.items() if k in allowed})
        for entry in flag_defs
    ]
    rest: list[str] = []
    if "--" in tokens:
        end = tokens.index("--")
        tokens, rest = tokens[:end], tokens[end + 1 :]
    flags = parse_flags(tokens, defs)

    lookup = {d["name"]: d for d in defs}
    positionals: list[str] = []
    tokens = expand_short_flags(tokens, defs)
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
    return [*positionals, *rest], flags


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


def dispatch_plugin_command(  # noqa: PLR0912
    *,
    plugin_name: str,
    command_name: str,
    tokens: list[str],
    config_path: Path | None,
    output_json: bool,
    invoking_command: str = "plugin",
    config_flag: str | None = None,
    print_help: Callable[[], None] | None = None,
) -> None:
    """Load config + plugins, parse forwarded flags, run one plugin command.

    Shared by ``chkit plugin <name> <cmd>`` and the top-level shortcuts
    (``chkit codegen``, ``chkit obsessiondb ...``), mirroring the TS CLI.
    A shortcut given an unknown command runs ``print_help`` after the error
    (not under ``--json``), as TS prints the command's help.

    As in TS, the command's flags also hold the global flags given:
    ``--json`` on every path, and ``--config`` (``config_flag``, the raw
    value) only from the shortcuts, which parse it with the command's flags;
    ``chkit plugin`` strips it first. A flag not given has no key.
    """
    # As in TS, `obsessiondb` / `plugin obsessiondb` may load the ObsessionDB
    # profile without a project config or credentials (to run `login`).
    config = load_config(
        config_path,
        ChxConfigEnv(command=invoking_command),
        allow_synthesized_profile=plugin_name == "obsessiondb",
    )
    runtime = load_plugin_runtime(
        [p for p in config.plugins if isinstance(p, ChxPlugin)]
    )
    if invoking_command == "plugin" and not runtime.plugins:
        _fail_no_plugins(json_mode=output_json)

    entry = next(
        (e for e in runtime.plugins if e.plugin.manifest.name == plugin_name), None
    )
    if entry is None:
        if invoking_command == "codegen":
            # As TS reports a well-known plugin command whose plugin is missing.
            report_usage_error(
                "codegen",
                "Codegen plugin is not configured. Add it to config.plugins first.",
                json_mode=output_json,
                code="plugin_not_configured",
            )
        raise _unknown_plugin_error(plugin_name, list(runtime.plugins))

    found = runtime.get_command(plugin_name, command_name)
    if found is None:
        known = [command.name for command in entry.plugin.commands or []]
        message = (
            f'Unknown {plugin_name} command "{command_name}". '
            f'Available: {", ".join(known) or "(none)"}.'
        )
        if invoking_command == "plugin":
            report_flag_error("plugin", message, json_mode=output_json)
        report_usage_error(
            invoking_command,
            message,
            json_mode=output_json,
            code="unknown_subcommand",
            on_text=print_help,
        )

    command_def, _command_owner = found
    flag_defs = list(command_def.flags or [])
    flag_defs.extend(_extended_flag_defs(runtime, plugin_name))
    try:
        positionals, flags = _split_positionals_and_flags(tokens, flag_defs)
    except (UnknownFlagError, MissingFlagValueError) as error:
        report_flag_error(invoking_command, str(error), json_mode=output_json)
    global_flags: ParsedFlags = {}
    if config_flag is not None:
        global_flags["--config"] = config_flag
    if output_json:
        global_flags["--json"] = True
    flags = {**global_flags, **flags}

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
            config_path=loaded_config_path(config_path),
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
        config = load_config(
            config_path,
            ChxConfigEnv(command="plugin"),
            allow_synthesized_profile=plugin_name == "obsessiondb",
        )
        runtime = load_plugin_runtime(
            [p for p in config.plugins if isinstance(p, ChxPlugin)]
        )
        loaded = list(runtime.plugins)
        if not loaded:
            _fail_no_plugins(json_mode=output_json)
        if plugin_name is None:
            _list_all(loaded, json_mode=output_json)
            return
        entry = next(
            (e for e in loaded if e.plugin.manifest.name == plugin_name), None
        )
        if entry is None:
            raise _unknown_plugin_error(plugin_name, loaded)
        _list_one(entry, json_mode=output_json)
        return

    dispatch_plugin_command(
        plugin_name=plugin_name,
        command_name=command_name,
        tokens=list(args or []),
        config_path=config_path,
        output_json=output_json,
    )
