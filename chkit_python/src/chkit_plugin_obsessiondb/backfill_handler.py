"""Route ``chkit plugin backfill …`` through ObsessionDB where appropriate.

1:1 port of ``packages/plugin-obsessiondb/src/backfill/handler.ts`` (end
state):

- ``submit`` — builds the chunk plan remotely and posts it to the jobs
  backend when authenticated + a service is selected; otherwise defers to
  the local command's "no managed backend" guidance.
- ``plan`` / ``run`` / ``resume`` — refused when ObsessionDB is the intended
  target (the managed path is ``backfill submit``); ``--local`` bypasses.
- ``status`` / ``cancel`` / ``list`` — routed to the jobs API by
  ``--job-id`` / ``--service-slug`` (``list`` defaults to the selected
  service); ``--plan-id`` keeps them local. They print the job as text, or
  the standard envelope under ``--json``.
"""

from __future__ import annotations

from typing import Any

from chkit.cli.json_output import json_error_code
from chkit.plugins import (
    ChxOnBeforePluginCommandContext,
    ChxOnBeforePluginCommandHandled,
    ChxOnBeforePluginCommandResult,
    ChxOnBeforePluginCommandUnhandled,
)
from chkit_plugin_obsessiondb.api_client import SessionExpiredError
from chkit_plugin_obsessiondb.backfill_job_output import (
    JobOutput,
    job_cancel_output,
    job_list_output,
    job_status_output,
)
from chkit_plugin_obsessiondb.backfill_submit import SubmitContext, handle_submit
from chkit_plugin_obsessiondb.console_url import build_job_console_url
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
from chkit_plugin_obsessiondb.json_envelope import error_envelope
from chkit_plugin_obsessiondb.storage import load_selected_service

_REMOTE_SUBCOMMANDS = frozenset({"status", "cancel", "list"})

# Backfill execution commands run the chunked query loop. Against ObsessionDB
# these must submit jobs to the backend rather than open a direct ClickHouse
# connection — the managed path is `backfill submit` — so we refuse them
# instead of silently falling back to a direct connection that bypasses
# ObsessionDB.
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
    context: ChxOnBeforePluginCommandContext,
) -> JobOutput:
    flags = context.flags
    command = context.command
    job_id = _str_flag(flags, "--job-id")
    service_slug = _str_flag(flags, "--service-slug")

    # --service-slug wins; otherwise the project's selected service.
    def resolve_service_slug() -> str | None:
        if service_slug is not None:
            return service_slug
        selected = load_selected_service(context.config_path)
        return selected.service_slug if selected is not None else None

    # The console deep-link needs a service slug; the job itself only carries
    # the service id.
    def console_url(job: str) -> str | None:
        slug = resolve_service_slug()
        return build_job_console_url(creds.base_url, slug, job) if slug else None

    if command == "status":
        if job_id is not None:
            return job_status_output(
                jobs_get(creds, job_id=job_id), console_url(job_id)
            )
        if service_slug is not None:
            return job_list_output(
                f"backfill {command}",
                service_slug,
                jobs_list(creds, service_slug=service_slug),
            )
        msg = "Either --job-id or --service-slug is required for remote status"
        raise RuntimeError(msg)
    if command == "cancel":
        if job_id is None:
            msg = "--job-id is required for remote cancel"
            raise RuntimeError(msg)
        jobs_cancel(creds, job_id=job_id)
        return job_cancel_output(job_id, console_url(job_id))
    if command == "list":
        slug = resolve_service_slug()
        if slug is None:
            msg = (
                "No service selected. Pass --service-slug or run "
                "`chkit obsessiondb service select`."
            )
            raise RuntimeError(msg)
        return job_list_output(
            f"backfill {command}",
            slug,
            jobs_list(creds, service_slug=slug),
        )
    msg = f"Unsupported remote command: {command}"
    raise RuntimeError(msg)


def _route_submit(
    context: ChxOnBeforePluginCommandContext,
) -> ChxOnBeforePluginCommandResult:
    """``submit`` targets ObsessionDB when authenticated and a service is
    selected (the same condition under which ``get_context`` hands out the
    remote executor). Without a service there is nothing to submit to, so
    defer to the local command's guidance."""
    creds = load_credentials()
    if creds is None:
        return ChxOnBeforePluginCommandUnhandled()

    selected = load_selected_service(context.config_path)
    if selected is None:
        return ChxOnBeforePluginCommandUnhandled()

    exit_code = handle_submit(
        SubmitContext(
            flags=dict(context.flags),
            config_path=context.config_path,
            json_mode=context.json_mode,
            config=context.config,
            print=context.print,
            credentials=_effective_credentials(creds),
            service_slug=selected.service_slug,
        )
    )
    return ChxOnBeforePluginCommandHandled(exit_code=exit_code)


def _guard_remote_execution(
    context: ChxOnBeforePluginCommandContext,
) -> ChxOnBeforePluginCommandResult:
    """``plan``/``run``/``resume`` run the chunk loop against a direct
    ClickHouse connection. Against ObsessionDB the managed path is
    ``backfill submit``, so point users there rather than silently opening a
    direct connection that bypasses ObsessionDB."""
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
        f"Backfill {context.command} runs locally and is not supported directly "
        "against ObsessionDB. Use `chkit backfill submit` to run it as a managed "
        "ObsessionDB job, or re-run with --local to execute against a direct "
        "ClickHouse connection."
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

    # --local flag bypasses remote routing and runs against the direct
    # ClickHouse connection.
    if context.flags.get("--local") is True:
        return ChxOnBeforePluginCommandUnhandled()

    # `submit` builds the plan with the same chunking algorithm as the local
    # path and submits it to the ObsessionDB job backend. Only intercept when
    # there is a backend to submit to (authenticated + service selected);
    # otherwise let the local command print its "no managed backend" guidance.
    if context.command == "submit":
        return _route_submit(context)

    if context.command in _EXECUTION_SUBCOMMANDS:
        return _guard_remote_execution(context)

    if context.command not in _REMOTE_SUBCOMMANDS:
        return ChxOnBeforePluginCommandUnhandled()

    # A local backfill plugin status/cancel command uses --plan-id. Do not let
    # the remote ObsessionDB hook shadow project-local backfill state commands.
    if isinstance(context.flags.get("--plan-id"), str):
        return ChxOnBeforePluginCommandUnhandled()

    command_id = f"backfill {context.command}"
    creds = load_credentials()
    if creds is None:
        message = "Not logged in. Run `chkit obsessiondb login` to authenticate."
        context.print(
            error_envelope(command_id, "not_logged_in", message)
            if context.json_mode
            else message
        )
        return ChxOnBeforePluginCommandHandled(exit_code=1)

    try:
        output = _dispatch(_effective_credentials(creds), context)
    except SessionExpiredError as error:
        context.print(
            error_envelope(command_id, "session_expired", str(error))
            if context.json_mode
            else str(error)
        )
        return ChxOnBeforePluginCommandHandled(exit_code=1)
    except Exception as error:
        context.print(
            error_envelope(command_id, json_error_code(error), str(error))
            if context.json_mode
            else f"Backfill {context.command} failed: {error}"
        )
        return ChxOnBeforePluginCommandHandled(exit_code=1)

    context.print(output.json if context.json_mode else output.text)
    return ChxOnBeforePluginCommandHandled(exit_code=0)


__all__ = ["handle_backfill_command"]
