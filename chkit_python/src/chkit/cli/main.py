"""Top-level Typer app and command wiring."""

from __future__ import annotations

import typer

from chkit import __version__
from chkit.cli.commands import (
    check,
    drift,
    generate,
    init,
    migrate,
    plugin,
    pull,
    query,
    status,
)

app = typer.Typer(
    name="chkit",
    help="ClickHouse schema and migration toolkit",
    add_completion=False,
)

app.command("init", help="Create a starter clickhouse.config.py and example schema.")(init.run)
app.command("generate", help="Generate a new migration from the current schema.")(generate.run)
app.command("migrate", help="Apply pending migrations to the target database.")(migrate.run)
app.command("status", help="Show migration status and pending operations.")(status.run)
app.command("check", help="Run pre-flight checks (drift, checksums, pending).")(check.run)
app.command("drift", help="Compare the live database against the schema snapshot.")(drift.run)
app.command("query", help="Run a SQL string against the configured ClickHouse target.")(query.run)
app.command("pull", help="Introspect live ClickHouse and emit a Python schema file.")(pull.run)
app.command("plugin", help="List configured plugins or dispatch a plugin command.")(plugin.run)


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
