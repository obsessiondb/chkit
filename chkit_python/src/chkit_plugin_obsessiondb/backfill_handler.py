"""Route ``chkit plugin backfill <status|cancel|list>`` over the jobs API.

1:1 port of ``packages/plugin-obsessiondb/src/backfill/handler.ts``.

Used as an ``on_before_plugin_command`` hook: when the user runs
``chkit plugin backfill status --job-id X``, the hook intercepts before
the (still-unported) local backfill plugin runs and routes the call to
``jobs.get(jobId)``. ``--local`` flag and ``--plan-id`` argument both
bypass the hook, so a local plan-id-driven check still works.
"""

from __future__ import annotations

from typing import Any

from chkit.plugins import (
    ChxOnBeforePluginCommandContext,
    ChxOnBeforePluginCommandHandled,
    ChxOnBeforePluginCommandResult,
    ChxOnBeforePluginCommandUnhandled,
)
from chkit_plugin_obsessiondb.api_client import SessionExpiredError
from chkit_plugin_obsessiondb.credentials import (
    Credentials,
    load_credentials,
    resolve_base_url,
)
from chkit_plugin_obsessiondb.jobs_api import (
    jobs_cancel,
    jobs_get,
    jobs_list,
)
from chkit_plugin_obsessiondb.storage import load_selected_service

_REMOTE_SUBCOMMANDS = frozenset({"status", "cancel", "list"})

# Backfill execution commands run the chunked query loop. Against ObsessionDB
# these would need to submit jobs to the backend (not yet implemented), so
# when authed + a service is selected we refuse them instead of silently
# falling through to the local Phase-2 stub or to a direct ClickHouse
# connection that bypasses ObsessionDB entirely.
_EXECUTION_SUBCOMMANDS = frozenset({"plan", "run", "resume"})


def _str_flag(flags: dict[str, Any], name: str) -> str | None:
    value = flags.get(name)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _effective_credentials(creds: Credentials) -> Credentials:
    return Credentials(
        access_token=creds.access_token,
        base_url=resolve_base_url(creds.base_url),
    )


def _dispatch(
    creds: Credentials,
    command: str,
    flags: dict[str, Any],
) -> Any:
    job_id = _str_flag(flags, "--job-id")
    service_slug = _str_flag(flags, "--service-slug")
    if command == "status":
        if job_id is not None:
            return jobs_get(creds, job_id=job_id)
        if service_slug is not None:
            return jobs_list(creds, service_slug=service_slug)
        msg = "Either --job-id or --service-slug is required for remote status"
        raise RuntimeError(msg)
    if command == "cancel":
        if job_id is None:
            msg = "--job-id is required for remote cancel"
            raise RuntimeError(msg)
        return jobs_cancel(creds, job_id=job_id)
    if command == "list":
        if service_slug is None:
            msg = "--service-slug is required for remote list"
            raise RuntimeError(msg)
        return jobs_list(creds, service_slug=service_slug)
    msg = f"Unsupported remote command: {command}"
    raise RuntimeError(msg)


def _guard_remote_execution(
    context: ChxOnBeforePluginCommandContext,
) -> ChxOnBeforePluginCommandResult:
    """Refuse backfill plan/run/resume when authed + a service is selected.

    Mirrors TS ``guardRemoteExecution``: the user explicitly opted into
    ObsessionDB routing (logged in AND a service selected, or --service flag
    set), but the remote backfill execution path isn't implemented yet. Rather
    than silently falling through to the local Phase-2 stub (or — worse — a
    direct ClickHouse connection that bypasses ObsessionDB), refuse with a
    clear message that nudges the user toward --local.
    """
    creds = load_credentials()
    if creds is None:
        return ChxOnBeforePluginCommandUnhandled()
    service_override = _str_flag(context.flags, "--service")
    has_service = service_override is not None or (
        load_selected_service(context.config_path) is not None
    )
    if not has_service:
        return ChxOnBeforePluginCommandUnhandled()
    message = (
        f"Backfill {context.command} against ObsessionDB is not supported yet — "
        "it would submit jobs to the ObsessionDB backend, which is not "
        "implemented. Re-run with --local to execute against a direct "
        "ClickHouse connection, or unselect the service with "
        "`chkit plugin obsessiondb service select`."
    )
    if context.json_mode:
        context.print(
            {
                "ok": False,
                "command": f"backfill {context.command}",
                "error": message,
            }
        )
    else:
        context.print(message)
    return ChxOnBeforePluginCommandHandled(exit_code=1)


def handle_backfill_command(  # noqa: PLR0911
    context: ChxOnBeforePluginCommandContext,
) -> ChxOnBeforePluginCommandResult:
    """Hook entry point: returns Handled (exit=0/1) or Unhandled."""
    if context.target_plugin != "backfill":
        return ChxOnBeforePluginCommandUnhandled()
    if context.flags.get("--local") is True:
        return ChxOnBeforePluginCommandUnhandled()
    # Execution subcommands are guarded BEFORE the remote-routing check:
    # they're not remote-routable (no job to query/cancel yet), but we still
    # want to short-circuit when ObsessionDB is the intended target.
    if context.command in _EXECUTION_SUBCOMMANDS:
        return _guard_remote_execution(context)
    if context.command not in _REMOTE_SUBCOMMANDS:
        return ChxOnBeforePluginCommandUnhandled()
    # A local plan-id status / cancel must not be shadowed by remote.
    if isinstance(context.flags.get("--plan-id"), str):
        return ChxOnBeforePluginCommandUnhandled()

    creds = load_credentials()
    if creds is None:
        context.print(
            "Not logged in. Run `chkit obsessiondb login` to authenticate."
        )
        return ChxOnBeforePluginCommandHandled(exit_code=1)

    try:
        result = _dispatch(_effective_credentials(creds), context.command, context.flags)
    except SessionExpiredError as error:
        context.print(str(error))
        return ChxOnBeforePluginCommandHandled(exit_code=1)
    except RuntimeError as error:
        context.print(str(error))
        return ChxOnBeforePluginCommandHandled(exit_code=1)

    context.print(result.model_dump() if hasattr(result, "model_dump") else result)
    return ChxOnBeforePluginCommandHandled(exit_code=0)
