"""Top-level Typer app and command wiring."""

from __future__ import annotations

from typing import Any

import typer
from typer.core import TyperGroup

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


class _ChkitGroup(TyperGroup):
    """Port of the TS CLI's top-level catch (``packages/cli/src/bin/chkit.ts``):
    a command that fails under ``--json`` without having written JSON yet still
    leaves stdout a parseable error envelope. The error is then re-raised, so
    stderr and the exit code stay as they were.
    """

    # Any: typer vendors click privately (typer._click), and the public
    # typer.Context subclass would narrow the parameter (mypy [override]).
    def invoke(self, ctx: Any) -> Any:
        # The group's parser leaves the subcommand's arguments in ctx.args.
        json_mode = "--json" in ctx.args
        try:
            return super().invoke(ctx)
        except (typer.Exit, typer.Abort):
            raise
        except Exception as error:
            if json_mode and not has_emitted_json():
                emit_json_error(
                    ctx.invoked_subcommand or "chkit",
                    {
                        "code": json_error_code(error),
                        "message": str(error) or type(error).__name__,
                    },
                )
            raise


app = typer.Typer(
    name="chkit",
    help="ClickHouse schema and migration toolkit",
    add_completion=False,
    cls=_ChkitGroup,
)

app.command("init", help="Create a starter clickhouse.config.py and example schema.")(init.run)
app.command("generate", help="Generate a new migration from the current schema.")(generate.run)
app.command("migrate", help="Apply pending migrations to the target database.")(migrate.run)
app.command("status", help="Show migration status and pending operations.")(status.run)
app.command("check", help="Run pre-flight checks (drift, checksums, pending).")(check.run)
app.command("drift", help="Compare the live database against the schema snapshot.")(drift.run)
app.command("snapshot", help=snapshot.SNAPSHOT_HELP)(snapshot.run)
app.command("query", help="Run a SQL string against the configured ClickHouse target.")(query.run)
app.command("pull", help="Introspect live ClickHouse and emit a Python schema file.")(pull.run)
app.command(
    "plugin",
    help="List configured plugins or dispatch a plugin command.",
    context_settings={"ignore_unknown_options": True},
)(plugin.run)
app.command(
    "codegen",
    help="Generate typed row models via the codegen plugin (shortcut).",
    context_settings={"ignore_unknown_options": True},
)(codegen_shortcut.run)
app.command(
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
