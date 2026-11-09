"""Help text in the layout of the TS CLI (``packages/cli/src/runtime/help.ts``).

``chkit -h`` and ``chkit <command> -h`` print the same plain text as TS, on
stdout. Where both CLIs have the same command and flags the text is the same,
byte for byte (``tests/test_cli_help_parity.py`` diffs it against
``test/fixtures/cli-help.json``, generated from the TS CLI). Each port lists
its own commands and flags.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

DOCS_URL = "https://chkit.obsessiondb.com/"
# A flag label this long or longer goes on its own line (TS ``formatFlagLine``).
_LABEL_WIDTH = 22

# TS ``TABLE_FLAG`` (``packages/cli/src/runtime/global-flags.ts``).
TABLE_FLAG_HELP = "Limit command scope to tables by exact name or trailing wildcard prefix"

# ``ctx.meta`` keys the CLI's parser sets for the help (``chkit.cli.main``).
HELP_PLUGINS_META = "chkit.help_plugins"
HELP_SUBCOMMAND_META = "chkit.help_subcommand"

INIT_HELP_DESCRIPTION = "Create a Python config and example schema."

# Every command takes these; the help lists them under "Global options".
_GLOBAL_OPTIONS = frozenset({"--config", "--json"})

# The flags the TS ObsessionDB plugin adds to commands through
# ``extendCommands``, one help section per extension, shown with
# --help-plugins. chkit-py declares them on the commands themselves
# (``chkit.cli.shared_engine_flags``, ``chkit.cli.command_target``), so its
# --help-plugins shows them without loading the config.
_PLUGIN_FLAG_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("obsessiondb", ("--force-shared-engines", "--no-shared-engines")),
    ("obsessiondb", ("--service",)),
)


@dataclass(frozen=True)
class HelpFlag:
    name: str
    description: str
    short: str | None = None
    placeholder: str | None = None


@dataclass(frozen=True)
class HelpCommand:
    name: str
    description: str
    flags: tuple[HelpFlag, ...] = ()
    # (plugin name, flags) for each flag group a plugin adds (TS ``pluginFlags``).
    plugin_flags: tuple[tuple[str, tuple[HelpFlag, ...]], ...] = ()
    subcommands: tuple[HelpCommand, ...] | None = field(default=None)


GLOBAL_FLAGS: tuple[HelpFlag, ...] = (
    HelpFlag(
        "--help-plugins",
        "Show help with configured plugin flags (loads config, skips initialization hooks)",
    ),
    HelpFlag("--config", "Path to config file", short="-c", placeholder="<path>"),
    HelpFlag("--json", "Emit machine-readable JSON output"),
)


def format_global_help(
    commands: Sequence[HelpCommand],
    plugin_commands: Sequence[HelpCommand],
    version: str,
) -> str:
    lines = [
        f"chkit v{version} - ClickHouse toolkit",
        "",
        "Usage:",
        "  chkit <command> [options]",
        "",
        "Commands:",
    ]
    lines.extend(f"  {cmd.name.ljust(14)} {cmd.description}" for cmd in commands)

    if plugin_commands:
        lines.append("")
        lines.append("Plugin commands:")
        for cmd in plugin_commands:
            lines.append(f"  {cmd.name.ljust(14)} {cmd.description}")
            lines.extend(
                f"    {sub.name.ljust(12)} {sub.description}" for sub in cmd.subcommands or ()
            )

    lines.append("")
    lines.append("Global options:")
    lines.extend(_format_flag_line(flag) for flag in GLOBAL_FLAGS)
    lines.append(_format_flag_line(HelpFlag("--help", "Show help", short="-h")))
    lines.append(_format_flag_line(HelpFlag("--version", "Show version", short="-v, -V")))
    _append_docs_help(lines)
    return "\n".join(lines)


def format_command_help(command: HelpCommand, subcommand_name: str | None = None) -> str:
    subcommand = next(
        (sub for sub in command.subcommands or () if sub.name == subcommand_name), None
    )
    lines: list[str] = []
    if subcommand is not None:
        lines.append(f"chkit {command.name} {subcommand.name} [options]")
        lines.append(f"  {subcommand.description}")
    elif command.subcommands is not None:
        lines.append(f"chkit {command.name} <command> [options]")
        lines.append(f"  {command.description}")
        lines.append("")
        lines.append("Commands:")
        lines.extend(
            f"  {sub.name.ljust(14)} {sub.description}" for sub in command.subcommands
        )
    else:
        lines.append(f"chkit {command.name} [options]")
        lines.append(f"  {command.description}")

    flags = subcommand.flags if subcommand is not None else command.flags
    if flags:
        lines.append("")
        lines.append("Options:")
        lines.extend(_format_flag_line(flag) for flag in flags)

    for plugin_name, plugin_flags in command.plugin_flags:
        lines.append("")
        lines.append(f"Plugin: {plugin_name}")
        lines.extend(_format_flag_line(flag) for flag in plugin_flags)

    lines.append("")
    lines.append("Global options:")
    lines.extend(_format_flag_line(flag) for flag in GLOBAL_FLAGS)
    lines.append(
        _format_flag_line(
            HelpFlag(
                "--help",
                "Show help; use --help-plugins to include configured extensions",
                short="-h",
            )
        )
    )
    _append_docs_help(lines)
    return "\n".join(lines)


def format_init_help(description: str, flags: Sequence[HelpFlag]) -> str:
    """``chkit init`` has its own layout in TS (``packages/cli/src/commands/init.ts``)."""
    rows = [*flags, HelpFlag("--help", "Show help without creating files or connecting", "-h")]
    lines = ["chkit init [options]", "", description, ""]
    lines.extend(f"  {_flag_label(flag).ljust(26)}{flag.description}" for flag in rows)
    lines.append("")
    return "\n".join(lines)


def plugin_help_command(plugin: Any) -> HelpCommand:
    """A plugin's entry in the help, as TS ``createCommandRegistry`` builds it:
    a plugin whose only command has the plugin's name is that command, any
    other plugin is ``chkit <plugin> <command>``."""
    name = plugin.manifest.name
    commands = [
        HelpCommand(
            name=command.name,
            description=command.description or "",
            flags=tuple(flag_from_def(flag) for flag in command.flags or ()),
        )
        for command in plugin.commands or ()
    ]
    if len(commands) == 1 and commands[0].name == name:
        return commands[0]
    return HelpCommand(name=name, description=f"Plugin: {name}", subcommands=tuple(commands))


def plugin_shortcuts() -> dict[str, Any]:
    """The plugins whose commands chkit-py runs as top-level commands
    (``chkit codegen``, ``chkit obsessiondb <command>``). The help lists them
    as TS lists a configured plugin's commands."""
    # Imported here: both plugins import chkit.cli modules.
    from chkit_plugin_codegen import codegen  # noqa: PLC0415
    from chkit_plugin_obsessiondb import obsessiondb  # noqa: PLC0415

    return {"codegen": codegen(), "obsessiondb": obsessiondb()}


def global_help_text(commands: Mapping[str, Any], version: str) -> str:
    """``chkit -h`` from the Typer group's commands (``click.Command``)."""
    shortcuts = plugin_shortcuts()
    return format_global_help(
        [
            HelpCommand(name, command.help or "")
            for name, command in commands.items()
            if name not in shortcuts and not command.hidden
        ],
        [plugin_help_command(plugin) for plugin in shortcuts.values()],
        version,
    )


def command_help_text(command: Any, meta: Mapping[str, Any]) -> str:
    """``chkit <command> -h`` from a Typer command (``click.Command``) and
    the ``ctx.meta`` the CLI's parser filled in (``--help-plugins``, the
    plugin command named before ``-h``)."""
    shortcut = plugin_shortcuts().get(command.name)
    if shortcut is not None:
        return format_command_help(
            plugin_help_command(shortcut), meta.get(HELP_SUBCOMMAND_META)
        )
    options = {
        _long_option(param): param
        for param in command.params
        if param.param_type_name == "option" and not param.hidden
    }
    if command.name == "init":
        return format_init_help(
            INIT_HELP_DESCRIPTION, [_option_flag(param) for param in options.values()]
        )
    plugin_flag_names = {name for _plugin, names in _PLUGIN_FLAG_GROUPS for name in names}
    flags = tuple(
        _option_flag(param)
        for name, param in options.items()
        if name not in _GLOBAL_OPTIONS and name not in plugin_flag_names
    )
    plugin_flags: tuple[tuple[str, tuple[HelpFlag, ...]], ...] = ()
    if meta.get(HELP_PLUGINS_META):
        plugin_flags = tuple(
            (plugin, tuple(_option_flag(options[name]) for name in names if name in options))
            for plugin, names in _PLUGIN_FLAG_GROUPS
            if any(name in options for name in names)
        )
    return format_command_help(
        HelpCommand(command.name, command.help or "", flags, plugin_flags)
    )


def _long_option(param: Any) -> str:
    opts: list[str] = param.opts
    return next((opt for opt in opts if opt.startswith("--")), opts[0])


def _option_flag(param: Any) -> HelpFlag:
    return HelpFlag(
        name=_long_option(param),
        description=param.help or "",
        short=next((opt for opt in param.opts if not opt.startswith("--")), None),
        placeholder=param.metavar,
    )


def flag_from_def(flag: dict[str, Any]) -> HelpFlag:
    return HelpFlag(
        name=flag["name"],
        description=flag.get("description", ""),
        short=flag.get("short"),
        placeholder=flag.get("placeholder"),
    )


def _flag_label(flag: HelpFlag) -> str:
    name = f"{flag.short}, {flag.name}" if flag.short else flag.name
    placeholder = f" {flag.placeholder}" if flag.placeholder else ""
    return f"{name}{placeholder}"


def _format_flag_line(flag: HelpFlag) -> str:
    label = _flag_label(flag)
    if len(label) >= _LABEL_WIDTH:
        # TS pads this line to 24, one short of the description column.
        return f"  {label}\n{''.ljust(24)}{flag.description}"
    return f"  {label.ljust(_LABEL_WIDTH)} {flag.description}"


def _append_docs_help(lines: list[str]) -> None:
    lines.append("")
    lines.append("Documentation:")
    lines.append(f"  Full documentation: {DOCS_URL}")
    lines.append("  Agent-readable markdown: fetch any docs page with Accept: text/markdown")
