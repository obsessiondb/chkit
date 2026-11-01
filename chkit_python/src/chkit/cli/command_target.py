"""The ClickHouse target of a command: a plugin executor, else the `clickhouse` block.

As in TS (``runtime.resolveContext``), a plugin's ``get_context`` executor
(ObsessionDB with a selected service) takes precedence over the
``clickhouse`` block, so ``check``, ``status``, ``migrate``, ``drift``,
``query`` and ``pull`` all run against the same server.
"""

from __future__ import annotations

import sys
from typing import Annotated, Any, NoReturn

import typer

from chkit.cli.json_output import emit_json_error, json_error_code
from chkit.cli.plugin_runtime import (
    PluginExecutionError,
    PluginRuntime,
    null_plugin_context,
)
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig, ChxResolvedConfig
from chkit.plugins import ChxGetContextInput, ChxOnInitContext

# The TS ObsessionDB plugin adds --service to these commands through
# extendCommands; Typer commands are static, so each declares it.
ServiceOption = Annotated[
    str | None,
    typer.Option(
        "--service",
        help="Override the selected ObsessionDB service by name for this command",
    ),
]


def resolve_plugin_executor(
    plugin_runtime: PluginRuntime,
    config: ChxResolvedConfig,
    *,
    command: str,
    config_path: str,
    json_mode: bool,
    service: str | None,
) -> ClickHouseClient | None:
    """Run the on_init hooks, then return the first plugin executor, or None."""
    # The hooks read --service under the key the TS flag parser produces.
    flags: dict[str, Any] = {"--service": service} if service is not None else {}
    # TS onInit: ObsessionDB names the selected service (text mode only).
    plugin_runtime.run_on_init(
        ChxOnInitContext(
            command=command,
            config_path=config_path,
            is_interactive=sys.stdin.isatty(),
            json_mode=json_mode,
            flags=flags,
            config=config,
            options={},
        )
    )
    try:
        plugin_context = plugin_runtime.resolve_context(
            ChxGetContextInput(
                config=config,
                config_path=config_path,
                command=command,
                flags=flags,
                defaults=null_plugin_context(),
            )
        )
    except PluginExecutionError as error:
        # Like the TS CLI's top-level handler: print the message (e.g. an
        # unknown --service) and exit 1 instead of a traceback.
        if json_mode:
            emit_json_error(command, {"code": json_error_code(error), "message": str(error)})
        typer.echo(str(error), err=True)
        raise typer.Exit(code=1) from error
    return plugin_context.executor if plugin_context is not None else None


def open_client(
    executor: ClickHouseClient | None, clickhouse: ChxResolvedClickHouseConfig | None
) -> ClickHouseClient:
    """The plugin executor, else a connection from the `clickhouse` block."""
    # Callers have checked that one of the two is set.
    if executor is not None:
        return executor
    assert clickhouse is not None
    return ClickHouseClient.connect(clickhouse)


def exit_no_target(command: str, message: str, *, json_mode: bool) -> NoReturn:
    """No executor and no `clickhouse` block: a runtime error, not a usage error.

    As in TS, the message goes to stderr (plus the JSON error envelope on
    stdout under ``--json``) and the command exits 1.
    """
    if json_mode:
        emit_json_error(command, {"code": "error", "message": message})
    typer.echo(message, err=True)
    raise typer.Exit(code=1)
