"""Claim a free ObsessionDB dev instance + persist as the project's service.

1:1 port of ``packages/plugin-obsessiondb/src/service/claim.ts``.

Three terminal states map to TS ``--json`` envelopes:

- ``already_claimed`` — the account already has a free instance; drops
  into the interactive picker so the user selects it for this project.
- ``none_available`` — capacity full; exits 1.
- ``provisioning_timeout`` — instance didn't reach ``running`` within the
  5-minute deadline; exits 1 with a hint to re-run ``service select``.

On success the service is persisted under ``.chkit/obsessiondb.json``.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.service_api import (
    ClaimInstanceAlreadyClaimed,
    ClaimInstanceClaimed,
    ClaimInstanceNoneAvailable,
    InstanceClaimStatusIneligible,
    Service,
    claim_instance,
    get_service,
    instance_claim_status,
    list_service_organizations,
)
from chkit_plugin_obsessiondb.service_select import (
    select_service_interactive,
    service_choice_label,
)
from chkit_plugin_obsessiondb.storage import (
    SelectedService,
    save_selected_service,
)

POLL_INTERVAL_SECONDS = 3.0
POLL_TIMEOUT_SECONDS = 5 * 60.0
CLAIM_COMMAND_ID = "obsessiondb service claim"


def _save(config_path: Path, *, slug: str, name: str, **extras: str) -> None:
    """Persist the selection under .chkit/obsessiondb.json."""
    save_selected_service(
        config_path,
        SelectedService(
            organization_id=extras.get("organization_id", ""),
            organization_slug=extras.get("organization_slug", ""),
            service_id=extras.get("service_id", ""),
            service_name=name,
            service_slug=slug,
        ),
    )


def _select_existing_instance(
    creds: Credentials,
    config_path: Path,
    print_fn: Callable[[object], None],
) -> int:
    """When the account is already claimed elsewhere, let the user pick it."""
    orgs = list_service_organizations(creds)
    selected = select_service_interactive(orgs, print_fn)
    if selected is None:
        return 1
    _save(
        config_path,
        slug=selected.service.slug,
        name=selected.service.name,
        organization_id=selected.organization.id,
        organization_slug=selected.organization.slug,
        service_id=selected.service.id,
    )
    print_fn(f"Service selected: {service_choice_label(selected)}")
    return 0


def _poll_until_running(
    creds: Credentials,
    slug: str,
    print_fn: Callable[[object], None],
    json_mode: bool,
    *,
    interval: float = POLL_INTERVAL_SECONDS,
    timeout: float = POLL_TIMEOUT_SECONDS,
    sleep: Any = time.sleep,
    monotonic: Any = time.monotonic,
) -> Service | None:
    """Poll ``services/get`` until the instance is running or fails terminally."""
    deadline = monotonic() + timeout
    while monotonic() < deadline:
        service = get_service(creds, service_slug=slug)
        if service.status == "running":
            return service
        if service.status in {"error", "terminated"}:
            if not json_mode:
                print_fn(
                    f"Provisioning failed — instance entered status "
                    f'"{service.status}".'
                )
            return None
        sleep(interval)
    return None


def run_claim(  # noqa: PLR0911, PLR0912
    creds: Credentials,
    config_path: Path,
    print_fn: Callable[[object], None],
    *,
    json_mode: bool = False,
) -> int:
    """Top-level claim flow; called by the ``service claim`` command."""
    status = instance_claim_status(creds)
    if isinstance(status, InstanceClaimStatusIneligible):
        if json_mode:
            print_fn({"command": CLAIM_COMMAND_ID, "ok": True, "status": "already_claimed"})
            return 0
        print_fn(
            f'You already have a free instance in organization '
            f'"{status.claimed_organization_name}".'
        )
        return _select_existing_instance(creds, config_path, print_fn)

    result = claim_instance(creds)
    if isinstance(result, ClaimInstanceNoneAvailable):
        message = (
            "No free dev instances are available right now. "
            "We have been notified — please try again later."
        )
        if json_mode:
            print_fn(
                {
                    "command": CLAIM_COMMAND_ID,
                    "ok": False,
                    "error": {"code": "none_available", "message": message},
                }
            )
        else:
            print_fn(message)
        return 1
    if isinstance(result, ClaimInstanceAlreadyClaimed):
        if json_mode:
            print_fn(
                {
                    "command": CLAIM_COMMAND_ID,
                    "ok": True,
                    "status": "already_claimed",
                }
            )
            return 0
        print_fn(
            f'You already have a free instance in organization '
            f'"{result.claimed_organization_name}".'
        )
        return _select_existing_instance(creds, config_path, print_fn)

    # The outcome is "claimed" at this point.
    assert isinstance(result, ClaimInstanceClaimed)
    if not json_mode:
        print_fn(
            f"Claimed a free instance ({result.slug}). "
            f"Provisioning — this can take a minute…"
        )

    service = _poll_until_running(creds, result.slug, print_fn, json_mode)
    if service is None:
        message = (
            "Instance is still provisioning. Run "
            "`chkit obsessiondb service select` once it is ready."
        )
        if json_mode:
            print_fn(
                {
                    "command": CLAIM_COMMAND_ID,
                    "ok": False,
                    "error": {"code": "provisioning_timeout", "message": message},
                }
            )
        else:
            print_fn(message)
        return 1

    _save(config_path, slug=service.slug, name=service.name, service_id=service.id)
    if json_mode:
        print_fn(
            {
                "command": CLAIM_COMMAND_ID,
                "ok": True,
                "status": "claimed",
                "service": {"slug": service.slug, "name": service.name},
            }
        )
    else:
        print_fn(f"Instance ready: {service.name} ({service.slug}).")
    return 0
