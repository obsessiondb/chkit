"""``chkit plugin obsessiondb service <subcommand>`` dispatch.

Maps `chkit plugin obsessiondb service list` (etc) into one ChxPluginCommand
named ``service`` whose ``run`` reads ``ctx.args[0]`` as the subcommand
name and routes to the right handler.

Subcommands:

- ``list`` — print every visible service across organisations.
- ``select`` — interactive picker; saves to .chkit/obsessiondb.json.
- ``claim`` — claim a free dev instance + poll until running.
- ``alias set <name> <service_slug>`` — store an alias.
- ``alias list`` — print user-global aliases.
- ``alias remove <name>`` — drop an alias.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from chkit.plugins import ChxPluginCommandContext
from chkit_plugin_obsessiondb.credentials import (
    Credentials,
    load_credentials,
    resolve_base_url,
)
from chkit_plugin_obsessiondb.json_envelope import (
    ServiceListEntry,
    error_envelope,
    service_list_envelope,
)
from chkit_plugin_obsessiondb.service_api import (
    list_service_organizations,
)
from chkit_plugin_obsessiondb.service_claim import run_claim
from chkit_plugin_obsessiondb.service_select import (
    render_service_organizations,
    select_service_interactive,
    service_choice_label,
)
from chkit_plugin_obsessiondb.storage import (
    SelectedService,
    load_selected_service,
    load_service_aliases,
    remove_service_alias,
    save_selected_service,
    save_service_alias,
)

_ALIAS_SET_ARGV_LEN = 2
_ALIAS_REMOVE_ARGV_LEN = 1


def _require_creds(
    print_fn: Any,
    *,
    base_url_override: str | None = None,
) -> Credentials | None:
    """Return creds (with optional ``--api-url`` override) or print a hint + None."""
    creds = load_credentials()
    if creds is None:
        print_fn("Not logged in. Run `chkit obsessiondb login` to authenticate.")
        return None
    if base_url_override is not None:
        return Credentials(access_token=creds.access_token, base_url=base_url_override)
    # Re-resolve the base URL in case the env var has been set since save.
    return Credentials(
        access_token=creds.access_token,
        base_url=resolve_base_url(creds.base_url),
    )


def _base_url_flag(flags: dict[str, Any]) -> str | None:
    value = flags.get("--api-url") or flags.get("api_url")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _service_list(ctx: ChxPluginCommandContext) -> int:
    # When --json is on, route the credential miss into a single error envelope
    # — no plain-text "Not logged in" line should leak.
    raw_creds = load_credentials()
    if raw_creds is None:
        message = "Not logged in. Run `chkit obsessiondb login` to authenticate."
        if ctx.json_mode:
            ctx.print(
                error_envelope("obsessiondb service list", "not_logged_in", message)
            )
        else:
            ctx.print(message)
        return 1
    override = _base_url_flag(ctx.flags)
    creds = Credentials(
        access_token=raw_creds.access_token,
        base_url=override if override is not None else resolve_base_url(raw_creds.base_url),
    )
    organizations = list_service_organizations(creds)
    selected = load_selected_service(ctx.config_path)
    if ctx.json_mode:
        services_payload: list[ServiceListEntry] = [
            {
                "organization": org.name,
                "slug": service.slug,
                "name": service.name,
                "selected": (
                    selected is not None
                    and (
                        selected.service_slug == service.slug
                        or selected.service_name == service.name
                    )
                ),
            }
            for org in organizations
            for service in org.services
        ]
        ctx.print(service_list_envelope(services_payload))
        return 0
    for line in render_service_organizations(organizations, selected):
        ctx.print(line)
    return 0


def _service_select(ctx: ChxPluginCommandContext) -> int:
    creds = _require_creds(ctx.print, base_url_override=_base_url_flag(ctx.flags))
    if creds is None:
        return 1
    organizations = list_service_organizations(creds)
    choice = select_service_interactive(organizations, ctx.print)
    if choice is None:
        return 1
    save_selected_service(
        Path(ctx.config_path),
        SelectedService(
            organization_id=choice.organization.id,
            organization_slug=choice.organization.slug,
            service_id=choice.service.id,
            service_name=choice.service.name,
            service_slug=choice.service.slug,
        ),
    )
    ctx.print(f"Service selected: {service_choice_label(choice)}")
    return 0


def _service_claim(ctx: ChxPluginCommandContext) -> int:
    creds = _require_creds(ctx.print, base_url_override=_base_url_flag(ctx.flags))
    if creds is None:
        return 1
    return run_claim(
        creds, Path(ctx.config_path), ctx.print, json_mode=ctx.json_mode
    )


def _validate_alias(alias: str) -> str | None:
    """Mirror of TS ``validateAlias``: empty / whitespace / ``--`` prefix rejected."""
    if not alias.strip():
        return "Alias is required."
    if alias != alias.strip():
        return "Alias cannot start or end with whitespace."
    if alias.startswith("--"):
        return 'Alias cannot start with "--".'
    return None


def _service_alias(ctx: ChxPluginCommandContext) -> int:  # noqa: PLR0911, PLR0912
    if not ctx.args:
        ctx.print(
            "Usage: chkit obsessiondb service alias <set|list|remove> [args]"
        )
        return 1
    subcommand = ctx.args[0]
    rest = ctx.args[1:]
    if subcommand == "list":
        aliases = load_service_aliases()
        if not aliases.aliases:
            ctx.print("No service aliases configured.")
            return 0
        ctx.print("Aliases:")
        for name in sorted(aliases.aliases):
            alias_target = aliases.aliases[name]
            ctx.print(
                f"  {name} → {alias_target.service_name} "
                f"({alias_target.service_slug})"
            )
        return 0
    if subcommand == "remove":
        if len(rest) != _ALIAS_REMOVE_ARGV_LEN:
            ctx.print("Usage: chkit obsessiondb service alias remove <name>")
            return 1
        if remove_service_alias(rest[0]):
            ctx.print(f'Removed alias "{rest[0]}".')
            return 0
        ctx.print(f'Alias "{rest[0]}" not found.')
        return 1
    if subcommand == "set":
        if len(rest) < _ALIAS_SET_ARGV_LEN:
            ctx.print(
                "Usage: chkit obsessiondb service alias set <name> <service-name>"
            )
            return 1
        alias_name = rest[0]
        # TS accepts service NAMES that may contain spaces ("alias set my prod"
        # → service "my prod"); join the remaining args so multi-word service
        # names work the same way as the TS CLI.
        service_name = " ".join(rest[1:]).strip()
        if not service_name:
            ctx.print("Service name is required.")
            return 1
        alias_error = _validate_alias(alias_name)
        if alias_error is not None:
            ctx.print(alias_error)
            return 1
        creds = _require_creds(ctx.print, base_url_override=_base_url_flag(ctx.flags))
        if creds is None:
            return 1
        organizations = list_service_organizations(creds)
        all_services = [
            (org, svc) for org in organizations for svc in org.services
        ]
        # Reject if the alias name collides with an existing service name —
        # mirrors TS to avoid shadowing (`--service <alias>` should always be
        # unambiguous).
        if any(svc.name == alias_name for _org, svc in all_services):
            ctx.print(
                f'Alias "{alias_name}" matches an existing service name; '
                f"use --service {alias_name} directly."
            )
            return 1
        for org, service in all_services:
            if service.name == service_name:
                save_service_alias(
                    alias_name,
                    SelectedService(
                        organization_id=org.id,
                        organization_slug=org.slug,
                        service_id=service.id,
                        service_name=service.name,
                        service_slug=service.slug,
                    ),
                )
                ctx.print(
                    f'Saved alias "{alias_name}" → {service.name} '
                    f"({service.slug})"
                )
                return 0
        available = (
            ", ".join(svc.name for _org, svc in all_services) or "<none>"
        )
        ctx.print(
            f'Service not found: {service_name}. Available services: {available}'
        )
        return 1
    ctx.print(f'Unknown alias subcommand "{subcommand}".')
    return 1


_SUBCOMMANDS = {
    "list": _service_list,
    "select": _service_select,
    "claim": _service_claim,
    "alias": _service_alias,
}


def service_command_run(ctx: ChxPluginCommandContext) -> int:
    """Single ``service`` ChxPluginCommand that dispatches by ``args[0]``."""
    if not ctx.args:
        ctx.print(
            "Usage: chkit plugin obsessiondb service <list|select|claim|alias> [args]"
        )
        return 1
    subcommand = ctx.args[0]
    handler = _SUBCOMMANDS.get(subcommand)
    if handler is None:
        ctx.print(f'Unknown service subcommand "{subcommand}".')
        return 1
    sub_ctx = ChxPluginCommandContext(
        plugin_name=ctx.plugin_name,
        config=ctx.config,
        config_path=ctx.config_path,
        json_mode=ctx.json_mode,
        args=list(ctx.args[1:]),
        flags=ctx.flags,
        options=ctx.options,
        raw_options=ctx.raw_options,
        table_scope=ctx.table_scope,
        print=ctx.print,
        plugin_runtime=ctx.plugin_runtime,
        plugin_context=ctx.plugin_context,
    )
    return handler(sub_ctx)
