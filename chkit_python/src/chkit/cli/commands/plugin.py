"""`chkit plugin [<name> [<command>]]` — list configured plugins / dispatch commands.

1:1 port of the user-facing surface of ``packages/cli/src/commands/plugin.ts``.

Usage:

    chkit plugin                     # list every configured plugin + its commands
    chkit plugin <name>              # list commands registered by one plugin
    chkit plugin <name> <command>    # dispatch the plugin command (with --args)
"""

from __future__ import annotations

import contextlib
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Annotated, Any, NoReturn, cast

import typer

from chkit.cli import command_lifecycle
from chkit.cli.command_target import run_on_config_loaded_or_exit
from chkit.cli.config_loader import load_config, loaded_config_path
from chkit.cli.flag_errors import report_flag_error, report_usage_error
from chkit.cli.json_output import emit_json, print_output
from chkit.cli.plugin_runtime import (
    PluginRuntime,
    load_plugin_runtime,
    make_plugin_context,
    null_plugin_context,
)
from chkit.cli.schema_loader import load_schema
from chkit.cli.table_scope import (
    TableScope,
    resolve_table_scope,
    table_keys_from_definitions,
)
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.flags import (
    FlagDef,
    MissingFlagValueError,
    ParsedFlags,
    UnknownFlagError,
    expand_short_flags,
    parse_flags,
)
from chkit.core.model import ChxConfigEnv, ChxResolvedConfig
from chkit.plugins import (
    ChxGetContextInput,
    ChxOnConfigLoadedContext,
    ChxOnInitContext,
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


def _init_hooks(
    runtime: PluginRuntime,
    config: ChxResolvedConfig,
    *,
    command: str,
    config_path: str,
    output_json: bool,
    flags: ParsedFlags,
) -> None:
    """Run the on_init hooks, as TS ``bin/chkit.ts`` does before any command."""
    command_lifecycle.run_on_init(
        runtime,
        ChxOnInitContext(
            command=command,
            config_path=config_path,
            is_interactive=sys.stdin.isatty(),
            json_mode=output_json,
            flags=dict(flags),
            config=config,
            options={},
        ),
    )


@contextlib.contextmanager
def _forwarder_context(
    runtime: PluginRuntime, config: ChxResolvedConfig, *, config_path: str, flags: ParsedFlags
) -> Iterator[None]:
    """``chkit plugin`` is itself a command, so its get_context hooks run with
    its own flags, as in TS (where every command is a plugin command). As in
    TS ``runPluginCommand``, the context lives until the command (listing or
    the target command) ends, then is disposed."""
    plugin_context = runtime.resolve_context(
        ChxGetContextInput(
            config=config,
            config_path=config_path,
            command="plugin",
            flags=dict(flags),
            defaults=null_plugin_context(),
        )
    )
    try:
        yield
    finally:
        if plugin_context is not None:
            runtime.dispose_context(plugin_context)


def _resolve_plugin_table_scope(
    schema: list[str], selector: str | None
) -> TableScope:
    """The scope of a plugin command that declares ``--table`` (TS
    ``resolvePluginTableScope``, #565).

    Without a selector the scope is unfiltered whatever the schema holds, so
    only a selector needs the schema. A plugin command that needs the schema
    loads it and reports its load errors itself, so a load error here leaves
    the selector resolved against no tables. An invalid selector raises.
    """
    if not selector:
        return resolve_table_scope(None, [])
    try:
        definitions = load_schema(schema)
    except Exception:
        definitions = []
    return resolve_table_scope(selector, table_keys_from_definitions(definitions))


def dispatch_plugin_command(  # noqa: PLR0912
    *,
    plugin_name: str,
    command_name: str | None,
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
    As there, a flag error ends the command before any hook; then on_init
    runs, then on_config_loaded on a shortcut, then the command (with its
    on_before_plugin_command and get_context hooks). The CLI group runs
    on_complete (#488). An unknown plugin or command is reported after
    on_init, as in TS; a shortcut given an unknown command runs
    ``print_help`` after the error (not under ``--json``), as TS prints the
    command's help; given no command (``command_name`` None), it runs
    ``print_help`` alone.

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
    resolved_config_path = loaded_config_path(config_path)
    is_forwarder = invoking_command == "plugin"

    # The global flags TS parses with the command's own: --json, and on a
    # shortcut also --config (`chkit plugin` strips it, so passes no
    # config_flag).
    own_flags: ParsedFlags = {}
    if config_flag is not None:
        own_flags["--config"] = config_flag
    if output_json:
        own_flags["--json"] = True

    entry = next(
        (e for e in runtime.plugins if e.plugin.manifest.name == plugin_name), None
    )
    found = None if command_name is None else runtime.get_command(plugin_name, command_name)
    flags: ParsedFlags
    positionals: list[str] = []
    if found is None:
        # As in TS, an unknown plugin or command is reported after on_init,
        # which then gets only the forwarder's flags (none on a shortcut).
        flags = own_flags if is_forwarder else {}
    else:
        flag_defs = [*(found[0].flags or []), *_extended_flag_defs(runtime, plugin_name)]
        try:
            positionals, parsed = _split_positionals_and_flags(tokens, flag_defs)
        except (UnknownFlagError, MissingFlagValueError) as error:
            report_flag_error(invoking_command, str(error), json_mode=output_json)
        flags = {**own_flags, **parsed}

    with contextlib.ExitStack() as forwarder_scope:
        _init_hooks(
            runtime,
            config,
            command=invoking_command,
            config_path=resolved_config_path,
            output_json=output_json,
            flags=flags,
        )
        if is_forwarder:
            forwarder_scope.enter_context(
                _forwarder_context(
                    runtime, config, config_path=resolved_config_path, flags=own_flags
                )
            )
            if not runtime.plugins:
                _fail_no_plugins(json_mode=output_json)

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
        if command_name is None:
            # A shortcut given no command shows its help after on_init (with
            # no flags), as TS does, also under --json.
            if print_help is not None:
                print_help()
            return
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

        # Set only when the command declares --table (#565). As in TS, the scope
        # is resolved after on_init and before on_config_loaded, which gets it.
        table_selector = flags.get("--table")
        table_scope = _resolve_plugin_table_scope(
            config.schema_,
            table_selector if isinstance(table_selector, str) else None,
        )
        if not is_forwarder:
            # TS runs on_config_loaded for a plugin command run by its own name,
            # not through `chkit plugin`.
            run_on_config_loaded_or_exit(
                runtime,
                ChxOnConfigLoadedContext(
                    command=invoking_command,
                    config=config,
                    table_scope=table_scope,
                    flags=dict(flags),
                    config_path=resolved_config_path,
                    options={},
                ),
                output_json=output_json,
            )

        exit_code = _run_command(
            runtime,
            config,
            plugin_name=plugin_name,
            command_name=command_name,
            config_path=resolved_config_path,
            output_json=output_json,
            args=positionals,
            flags=flags,
            table_scope=table_scope,
        )
        if exit_code != 0:
            raise typer.Exit(code=exit_code)


def _run_command(
    runtime: PluginRuntime,
    config: ChxResolvedConfig,
    *,
    plugin_name: str,
    command_name: str,
    config_path: str,
    output_json: bool,
    args: list[str],
    flags: ParsedFlags,
    table_scope: TableScope,
) -> int:
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
            config_path=config_path,
            json_mode=output_json,
            args=args,
            flags=dict(flags),
            options={},
            raw_options={},
            table_scope=table_scope,
            # TS routes plugin prints through printOutput: --json emits real
            # JSON (bare strings wrapped in {schemaVersion, message}); plain
            # mode prints strings only.
            print=lambda value: print_output(value, json_mode=output_json),
            plugin_runtime=runtime,
            plugin_context=plugin_context,
        )
        return runtime.run_plugin_command(plugin_name, command_name, ctx)
    finally:
        if cm is not None:
            cm.close()


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
        # As in TS, listing is a command too: on_init and get_context run.
        resolved_config_path = loaded_config_path(config_path)
        own_flags: ParsedFlags = {"--json": True} if output_json else {}
        _init_hooks(
            runtime,
            config,
            command="plugin",
            config_path=resolved_config_path,
            output_json=output_json,
            flags=own_flags,
        )
        with _forwarder_context(
            runtime, config, config_path=resolved_config_path, flags=own_flags
        ):
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
