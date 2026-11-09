"""Top-level Typer app and command wiring."""

from __future__ import annotations

import logging
import re
from typing import Any

import typer
from typer._click.exceptions import UsageError  # click, which typer vendors privately
from typer.core import TyperCommand, TyperGroup
from typer.exceptions import TyperException

from chkit import __version__
from chkit.cli.argv import GLOBAL_FLAGS, extract_config_path, normalize_global_args
from chkit.cli.commands import (
    check,
    codegen_shortcut,
    drift,
    generate,
    init,
    migrate,
    obsessiondb_shortcut,
    plugin,
    pull,
    query,
    snapshot,
    status,
)
from chkit.cli.flag_errors import report_flag_error
from chkit.cli.json_output import emit_json_error, has_emitted_json, json_error_code
from chkit.cli.logging_setup import configure_cli_logging, is_debug_enabled
from chkit.clickhouse.client import clickhouse_error_message
from chkit.core.flags import MissingFlagValueError, UnknownFlagError, expand_short_flags

_HELP_OPTION_NAMES = ("-h", "--help")
# The top-level options, which TS reads only as the first token.
_ROOT_OPTION_NAMES = (*_HELP_OPTION_NAMES, "-v", "-V", "--version")


def _option_args(args: list[str]) -> list[str]:
    """The tokens before the first ``--`` (TS ``optionArgs``): after it,
    ``--json`` is an argument, not an option (#568)."""
    return args[: args.index("--")] if "--" in args else args


def _option_forms(params: list[Any]) -> tuple[dict[str, bool], dict[str, str]]:
    """Map every form of every option (``-t``, ``--table``) to whether it takes
    a value, and to the long form TS names the flag by."""
    takes_value: dict[str, bool] = {}
    long_form: dict[str, str] = {}
    for param in params:
        if param.param_type_name != "option":
            continue
        long = next((opt for opt in param.opts if opt.startswith("--")), param.opts[0])
        for opt in [*param.opts, *param.secondary_opts]:
            takes_value[opt] = not (param.is_flag or param.count)
            long_form[opt] = long if opt in param.opts else opt
    return takes_value, long_form


def _normalize_short_options(args: list[str], params: list[Any]) -> list[str]:
    """Read a command's options the way the TS CLI does (#491, #563).

    click takes ``-t=x`` as the value ``=x`` and accepts bundles such as
    ``-fo x``; TS reads ``-t=x`` as ``--table=x`` and rejects a bundle as an
    unknown flag. So ``-t=x`` becomes ``-t x``. A value, including one that
    looks like a short flag (``--name -t=x``), and everything after ``--``
    pass through unchanged.

    The flags TS's ``parseFlags`` rejects raise the same errors here, with the
    same flag in the message: an unknown flag (``UnknownFlagError``:
    ``--nope``, ``-x``, a bundle such as ``-fo``, a boolean flag given a value
    such as ``--json=1``) and a value flag at the end or followed by a ``--``
    token (``MissingFlagValueError``).
    """
    takes_value, long_form = _option_forms(params)

    normalized: list[str] = []
    i = 0
    while i < len(args):
        token = args[i]
        i += 1
        if token == "--":
            normalized.extend(args[i - 1 :])
            break
        if token in _HELP_OPTION_NAMES or token == "-" or not token.startswith("-"):
            normalized.append(token)
            continue
        if token.startswith("--"):
            name, eq, value = token.partition("=")
            rest = eq + value
        else:
            name, rest = token[:2], token[2:]
        # As in TS, only an exact -h / --help is help: -hx and --help=1 are unknown.
        if name not in takes_value or name in _HELP_OPTION_NAMES:
            raise UnknownFlagError(token.split("=", 1)[0])
        if not takes_value[name]:
            if rest.startswith("="):
                raise UnknownFlagError(long_form[name] + rest)
            if rest:
                raise UnknownFlagError(token)
            normalized.append(token)
            continue
        if rest:
            normalized.extend([name, rest[1:] if rest.startswith("=") else rest])
            continue
        if i >= len(args) or args[i].startswith("--"):
            raise MissingFlagValueError(long_form[name])
        normalized.extend([token, args[i]])
        i += 1
    return normalized


def _after_dash_dash(rest: list[str], missing_names: int) -> list[str]:
    """The forwarded tokens for the user's ``--`` and the ``rest`` after it.

    Names the forwarder still needs (plugin, command) come first, then the
    ``--`` that ends the plugin command's flags (#568). Without those names the
    ``--`` ends nothing and is dropped, as in TS.
    """
    missing = max(missing_names, 0)
    if len(rest) < missing:
        return rest
    return [*rest[:missing], "--", *rest[missing:]]


def _split_forwarded_args(args: list[str], params: list[Any]) -> list[str]:
    """Separate a plugin forwarder's own options from the plugin's arguments.

    ``plugin``, ``codegen`` and ``obsessiondb`` pass unknown tokens to the
    plugin command, but click would still read the letters of a token such as
    ``-hmodels.py`` (a value of ``--out-file``) or ``-xh`` as its own short
    options. As in TS, only the forwarder's options in their exact forms
    (``-h``, ``--json``, ``-c x`` / ``-c=x`` / ``-cx``, ``--config x``) are
    read here; every other token goes behind ``--``, in order, so click hands
    it to the plugin untouched (#491). A ``--`` of the user's own is kept, so
    the plugin command reads it as the end of its flags (#568). The plugin and
    command names still come first, as in TS: ``plugin -- p c x`` forwards
    ``p c -- x``.
    """
    takes_value, long_form = _option_forms(params)
    # The forwarder's own positional names (plugin, command), which a
    # user's `--` must not swallow (#568).
    names = sum(
        1 for param in params if param.param_type_name == "argument" and param.nargs == 1
    )

    end = args.index("--") if "--" in args else len(args)
    help_requested = any(token in _HELP_OPTION_NAMES for token in args[:end])

    own: list[str] = []
    forwarded: list[str] = []
    i = 0
    while i < len(args):
        token = args[i]
        i += 1
        if token == "--":
            forwarded.extend(_after_dash_dash(args[i:], names - len(forwarded)))
            break
        long_name = token.split("=", 1)[0] if token.startswith("--") else None
        short_name = token[:2] if long_name is None else None
        if token in takes_value:
            own.append(token)
            if takes_value[token]:
                # As TS `extractConfigPath`: last, or followed by a `--` token,
                # the flag has no value. click would take that token (or the
                # `--` below) as the value. A -h / --help before `--` still
                # shows the help, as TS handles help first.
                if i >= len(args) or (args[i].startswith("--") and not help_requested):
                    raise MissingFlagValueError(long_form[token])
                own.append(args[i])
                i += 1
        elif long_name is not None and takes_value.get(long_name):
            own.append(token)
        elif short_name is not None and takes_value.get(short_name):
            value = token[2:]
            own.extend([short_name, value[1:] if value.startswith("=") else value])
        else:
            forwarded.append(token)
    return [*own, "--", *forwarded]


# JavaScript's `\s`, so both ports split SQL from flags on the same characters.
_JS_WHITESPACE = re.compile(
    "[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"
)


def _looks_like_flag(token: str) -> bool:
    """As TS ``looksLikeFlag``: a ``-`` token is a flag unless it holds a line
    break, or whitespace before any ``=``, as SQL that starts with a line
    comment does (``-- note\\nSELECT 1``, ``--tag=x\\nSELECT 1``). A lone
    ``-`` is not a flag."""
    if not token.startswith("-") or token == "-":
        return False
    if "\n" in token or "\r" in token:
        return False
    return _JS_WHITESPACE.search(token.split("=", 1)[0]) is None


def _query_sql_behind_terminator(args: list[str], params: list[Any]) -> list[str]:
    """Port of TS ``splitQueryArgs`` for ``chkit query`` (#584).

    click reads every argument that starts with ``-`` as an option, so SQL
    that starts with a line comment would be an unknown option. The SQL
    arguments go behind ``--``, in order; option values stay with their
    option, and a token that looks like a flag stays in front, so click
    still rejects an unknown one such as ``-x`` or ``--bogus``.
    """
    takes_value: dict[str, bool] = {}
    for param in params:
        if param.param_type_name == "option":
            for opt in [*param.opts, *param.secondary_opts]:
                takes_value[opt] = not (param.is_flag or param.count)

    options: list[str] = []
    positionals: list[str] = []
    i = 0
    while i < len(args):
        token = args[i]
        i += 1
        if token == "--":
            positionals.extend(args[i:])
            break
        # A declared option, with its value attached (`-c/my dir/c.py`,
        # `--config=/my dir/c.py`) or not, is an option whatever it holds.
        name = token.split("=", 1)[0] if token.startswith("--") else token[:2]
        if name not in takes_value and not _looks_like_flag(token):
            positionals.append(token)
            continue
        options.append(token)
        if takes_value.get(token):
            # Without its value, click would take the `--` below as the value.
            if i >= len(args):
                raise MissingFlagValueError(token)
            options.append(args[i])
            i += 1
    return [*options, "--", *positionals] if positionals else options


class _ChkitCommand(TyperCommand):
    """Every chkit command reads its options as TS does (#491) and reports a
    flag error as TS does (#563)."""

    def parse_args(self, ctx: Any, args: list[str]) -> list[str]:
        params = self.get_params(ctx)
        try:
            if ctx.ignore_unknown_options:
                normalized = _split_forwarded_args(args, params)
            elif any(token in _HELP_OPTION_NAMES for token in _option_args(args)):
                # As in TS, -h / --help anywhere before `--` shows the help, even
                # next to a flag error or where it would be a flag's value.
                normalized = ["--help"]
            else:
                # query first moves its SQL arguments behind `--` (#584), so SQL
                # that starts with a dash is not read as a flag here.
                if self.name == "query":
                    args = _query_sql_behind_terminator(args, params)
                normalized = _normalize_short_options(args, params)
        except (UnknownFlagError, MissingFlagValueError) as error:
            # A forwarder's own flag error here is a missing --config, which TS
            # reports before dispatching, so `plugin` gets the usage envelope.
            report_flag_error(
                ctx.info_name,
                str(error),
                json_mode="--json" in _option_args(args),
                global_flag=ctx.ignore_unknown_options,
            )
        return super().parse_args(ctx, normalized)


class _ChkitGroup(TyperGroup):
    """Port of the TS CLI's top-level catch (``packages/cli/src/bin/chkit.ts``):
    a command that fails under ``--json`` without having written JSON yet still
    leaves stdout a parseable error envelope. An unhandled error then prints
    its message as one line on stderr and exits 1; ``CHKIT_DEBUG=1`` also logs
    the traceback. A usage error of the command (an unexpected argument, a
    value that is not one of the choices) is reported as TS reports one: one
    line on stderr, exit 1 and, under ``--json``, a ``usage`` error envelope.
    A usage error before the command is resolved is re-raised, so click
    still reports it.
    """

    def parse_args(self, ctx: Any, args: list[str]) -> list[str]:
        """Read the tokens before the command as ``run`` in ``packages/cli/src/bin/chkit.ts``
        does (#597): leading global flags move behind the command, help or the
        version first ignores the rest, and any other first token that is not
        a command is an unknown command."""
        try:
            normalized = normalize_global_args(args)
        except MissingFlagValueError as error:
            # TS's top-level catch: command "chkit", the error's own JSON code.
            if "--json" in _option_args(args):
                emit_json_error("chkit", {"code": json_error_code(error), "message": str(error)})
            typer.echo(str(error), err=True)
            raise typer.Exit(code=1) from error
        if normalized and normalized[0] in _ROOT_OPTION_NAMES:
            normalized = normalized[:1]
        elif normalized and self.get_command(ctx, normalized[0]) is None:
            command = normalized[0]
            # As TS, which reads the config path before it finds the command unknown.
            try:
                extract_config_path(expand_short_flags(normalized[1:], GLOBAL_FLAGS))
            except MissingFlagValueError as error:
                report_flag_error(command, str(error), json_mode="--json" in normalized)
            message = f"Unknown command: {command}"
            typer.echo(message, err=True)
            if "--json" in _option_args(normalized):
                emit_json_error(command, {"code": "unknown_command", "message": message})
            else:
                typer.echo(ctx.get_help())
            raise typer.Exit(code=1)
        return super().parse_args(ctx, normalized)

    # Any: typer vendors click privately (typer._click), and the public
    # typer.Context subclass would narrow the parameter (mypy [override]).
    def invoke(self, ctx: Any) -> Any:
        # The group's parser leaves the subcommand's arguments in ctx.args.
        json_mode = "--json" in _option_args(ctx.args)
        try:
            return super().invoke(ctx)
        except (typer.Exit, typer.Abort, BrokenPipeError):
            raise
        except Exception as error:
            # A usage error of the resolved command: its arguments or its
            # option values. A command that already wrote JSON keeps it alone.
            if isinstance(error, UsageError) and ctx.invoked_subcommand is not None:
                report_flag_error(
                    ctx.invoked_subcommand,
                    error.format_message(),
                    json_mode=json_mode and not has_emitted_json(),
                )
            if is_debug_enabled():
                configure_cli_logging()
                logging.getLogger("chkit.cli").debug("fatal error", exc_info=error)
            message = clickhouse_error_message(error) or type(error).__name__
            if json_mode and not has_emitted_json():
                emit_json_error(
                    ctx.invoked_subcommand or "chkit",
                    {"code": json_error_code(error), "message": message},
                )
            if isinstance(error, TyperException):
                raise
            typer.echo(message, err=True)
            raise typer.Exit(code=1) from error


app = typer.Typer(
    name="chkit",
    help="ClickHouse schema and migration toolkit",
    add_completion=False,
    cls=_ChkitGroup,
    # As in TS, -h is --help on every command (#491).
    context_settings={"help_option_names": list(_HELP_OPTION_NAMES)},
)


def _command(name: str, **kwargs: Any) -> Any:
    return app.command(name, cls=_ChkitCommand, **kwargs)


_command("init", help="Create a starter clickhouse.config.py and example schema.")(init.run)
_command("generate", help="Generate a new migration from the current schema.")(generate.run)
_command("migrate", help="Apply pending migrations to the target database.")(migrate.run)
_command("status", help="Show migration status and pending operations.")(status.run)
_command("check", help="Run pre-flight checks (drift, checksums, pending).")(check.run)
_command("drift", help="Compare the live database against the schema snapshot.")(drift.run)
_command("snapshot", help=snapshot.SNAPSHOT_HELP)(snapshot.run)
_command("query", help="Run a SQL string against the configured ClickHouse target.")(query.run)
_command("pull", help="Introspect live ClickHouse and emit a Python schema file.")(pull.run)
_command(
    "plugin",
    help="List configured plugins or dispatch a plugin command.",
    context_settings={"ignore_unknown_options": True},
)(plugin.run)
_command(
    "codegen",
    help="Generate typed row models via the codegen plugin (shortcut).",
    context_settings={"ignore_unknown_options": True},
)(codegen_shortcut.run)
_command(
    "obsessiondb",
    help="Run ObsessionDB commands (login, signup, service, ...) via the plugin.",
    context_settings={"ignore_unknown_options": True},
)(obsessiondb_shortcut.run)


@app.callback(invoke_without_command=True)
def _root(
    ctx: typer.Context,
    version: bool = typer.Option(
        False,  # noqa: FBT003 - typer positional default is part of its API
        "--version",
        "-V",
        "-v",
        help="Show the chkit version and exit.",
    ),
) -> None:
    if version:
        typer.echo(__version__)
        raise typer.Exit(code=0)
    if ctx.invoked_subcommand is None:
        typer.echo(ctx.get_help())
        raise typer.Exit(code=0)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
