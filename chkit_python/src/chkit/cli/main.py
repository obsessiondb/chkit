"""Top-level Typer app and command wiring."""

from __future__ import annotations

import logging
from typing import Any

import typer
from typer.core import TyperCommand, TyperGroup
from typer.exceptions import TyperException

from chkit import __version__
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
from chkit.cli.json_output import emit_json_error, has_emitted_json, json_error_code
from chkit.cli.logging_setup import configure_cli_logging, is_debug_enabled
from chkit.clickhouse.client import clickhouse_error_message


def _normalize_short_options(
    ctx: Any, args: list[str], params: list[Any], *, leading_only: bool = False
) -> list[str]:
    """Read short options the way the TS CLI does (#491).

    click takes ``-t=x`` as the value ``=x`` and accepts bundles such as
    ``-fo x``; TS reads ``-t=x`` as ``--table=x`` and rejects a bundle as an
    unknown flag. So ``-t=x`` becomes ``-t x`` and a short flag that takes no
    value followed by more characters (``-fo``, ``-hx``) is a usage error. A
    value, including one that looks like a short flag (``--name -t=x``),
    unknown options and everything after ``--`` pass through unchanged.
    ``leading_only`` stops at the first argument, for the top-level group,
    whose remaining arguments belong to the subcommand.
    """
    takes_value: dict[str, bool] = {}
    for param in params:
        if param.param_type_name == "option":
            for opt in [*param.opts, *param.secondary_opts]:
                takes_value[opt] = not (param.is_flag or param.count)

    normalized: list[str] = []
    i = 0
    while i < len(args):
        token = args[i]
        i += 1
        if token == "--" or (leading_only and not token.startswith("-")):
            normalized.extend(args[i - 1 :])
            break
        name = token if token.startswith("--") else token[:2]
        rest = "" if token.startswith("--") else token[2:]
        if name not in takes_value:
            normalized.append(token)
            continue
        if not takes_value[name]:
            if rest:
                ctx.fail(f"No such option: {token}")
            normalized.append(token)
            continue
        if rest.startswith("="):
            normalized.extend([name, rest[1:]])
            continue
        normalized.append(token)
        if not rest and i < len(args):
            normalized.append(args[i])
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


def _split_forwarded_args(ctx: Any, args: list[str], params: list[Any]) -> list[str]:
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
    takes_value: dict[str, bool] = {}
    names = 0
    for param in params:
        if param.param_type_name == "option":
            for opt in [*param.opts, *param.secondary_opts]:
                takes_value[opt] = not (param.is_flag or param.count)
        elif param.param_type_name == "argument" and param.nargs == 1:
            names += 1

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
                # Without its value, click would take the `--` below as the value.
                if i >= len(args):
                    ctx.fail(f"Option '{token}' requires an argument.")
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


class _ChkitCommand(TyperCommand):
    """Every chkit command reads short options as TS does (#491)."""

    def parse_args(self, ctx: Any, args: list[str]) -> list[str]:
        params = self.get_params(ctx)
        if ctx.ignore_unknown_options:
            return super().parse_args(ctx, _split_forwarded_args(ctx, args, params))
        return super().parse_args(ctx, _normalize_short_options(ctx, args, params))


class _ChkitGroup(TyperGroup):
    """Port of the TS CLI's top-level catch (``packages/cli/src/bin/chkit.ts``):
    a command that fails under ``--json`` without having written JSON yet still
    leaves stdout a parseable error envelope. An unhandled error then prints
    its message as one line on stderr and exits 1; ``CHKIT_DEBUG=1`` also logs
    the traceback. Usage errors are re-raised, so click still reports them.
    """

    def parse_args(self, ctx: Any, args: list[str]) -> list[str]:
        return super().parse_args(
            ctx,
            _normalize_short_options(
                ctx, args, self.get_params(ctx), leading_only=True
            ),
        )

    # Any: typer vendors click privately (typer._click), and the public
    # typer.Context subclass would narrow the parameter (mypy [override]).
    def invoke(self, ctx: Any) -> Any:
        # The group's parser leaves the subcommand's arguments in ctx.args.
        json_mode = "--json" in ctx.args
        try:
            return super().invoke(ctx)
        except (typer.Exit, typer.Abort, BrokenPipeError):
            raise
        except Exception as error:
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
    context_settings={"help_option_names": ["-h", "--help"]},
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
