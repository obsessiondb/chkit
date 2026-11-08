"""The ClickHouse target of a command: a plugin executor, else the `clickhouse` block.

As in TS (``runtime.resolveContext``), a plugin's ``get_context`` executor
(ObsessionDB with a selected service) takes precedence over the
``clickhouse`` block, so ``check``, ``status``, ``migrate``, ``drift``,
``query`` and ``pull`` all run against the same server.
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from typing import Annotated, Any, NoReturn

import typer

from chkit.cli.json_output import emit_json_error, json_error_code
from chkit.cli.plugin_runtime import (
    PluginExecutionError,
    PluginRuntime,
    null_plugin_context,
)
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.index_granularity import (
    IndexGranularityMismatchError,
    assert_server_index_granularity,
)
from chkit.core.model import (
    ChxResolvedClickHouseConfig,
    ChxResolvedConfig,
    configured_index_granularity,
)
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
    flags: dict[str, Any] | None = None,
    after_init: Callable[[], None] | None = None,
) -> ClickHouseClient | None:
    """Run the on_init hooks, then return the first plugin executor, or None.

    ``flags`` is the command's parsed-flag dict (``hook_flags.passed_flags``)
    for both hooks; without it they get only ``--service``. ``after_init``
    runs between the two hooks, where TS runs a plugin command's
    on_config_loaded hooks.
    """
    # The hooks read --service under the key the TS flag parser produces.
    if flags is None:
        flags = {"--service": service} if service is not None else {}
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
    if after_init is not None:
        after_init()
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


def assert_index_granularity_matches_server(
    command: str, client: Any, config: ChxResolvedConfig, *, json_mode: bool
) -> None:
    """Stop a connected command when the server's MergeTree index_granularity
    default is not ``clickhouse.indexGranularity``: drift, plans and cutovers
    would all assume the wrong value for tables that do not declare it (#466).
    The error is reported as TS reports a thrown error: on stderr, plus the JSON
    error envelope under ``--json``, and exit 1."""
    try:
        assert_server_index_granularity(client, configured_index_granularity(config))
    except IndexGranularityMismatchError as error:
        if json_mode:
            emit_json_error(command, {"code": error.code, "message": str(error)})
        typer.echo(str(error), err=True)
        raise typer.Exit(code=1) from error
