"""Interactive + scripted service picker for ``chkit obsessiondb service``.

1:1 port of ``packages/plugin-obsessiondb/src/service/select.ts``.

Two surfaces:

- ``render_service_organizations`` — pure function that returns the lines
  to print for non-interactive output (``chkit obsessiondb service list``).
- ``select_service_interactive`` — TTY picker that returns the user's
  choice (or None on cancellation). Auto-selects when there's a single
  service available.
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from dataclasses import dataclass

from chkit_plugin_obsessiondb.service_api import (
    Service,
    ServiceOrganization,
)
from chkit_plugin_obsessiondb.storage import SelectedService


@dataclass(frozen=True, slots=True)
class ServiceChoice:
    organization: ServiceOrganization
    service: Service


def _organization_label(org: ServiceOrganization) -> str:
    if org.slug and org.slug != org.name:
        return f"{org.name} ({org.slug})"
    return org.name


def service_choice_label(choice: ServiceChoice) -> str:
    return f"{_organization_label(choice.organization)} / {choice.service.name}"


def _flatten_choices(
    organizations: list[ServiceOrganization],
) -> list[ServiceChoice]:
    return [
        ServiceChoice(organization=org, service=service)
        for org in organizations
        for service in org.services
    ]


def render_service_organizations(
    organizations: list[ServiceOrganization],
    selected: SelectedService | None = None,
) -> list[str]:
    """Return the lines to print for ``chkit obsessiondb service list``."""
    choices = _flatten_choices(organizations)
    if not choices:
        return ["No services found."]
    lines = ["Services:"]
    for org in organizations:
        if not org.services:
            continue
        lines.append(f"{_organization_label(org)}:")
        for service in org.services:
            is_selected = selected is not None and (
                selected.service_slug == service.slug
                or selected.service_name == service.name
            )
            suffix = " [default]" if is_selected else ""
            lines.append(f"  - {service.name} ({service.status}){suffix}")
    return lines


def _is_tty_stdin() -> bool:
    return bool(getattr(sys.stdin, "isatty", lambda: False)())


def select_service_interactive(  # noqa: PLR0911
    organizations: list[ServiceOrganization],
    print_fn: Callable[[str], None],
) -> ServiceChoice | None:
    """Prompt the user to pick one service. Auto-selects when only one exists."""
    choices = _flatten_choices(organizations)
    if not choices:
        print_fn("No services found.")
        return None

    if len(choices) == 1:
        only = choices[0]
        print_fn(
            f"Auto-selected service: {service_choice_label(only)} "
            f"({only.service.status})"
        )
        return only

    print_fn("\nAvailable services:")
    n = 1
    for org in organizations:
        if not org.services:
            continue
        print_fn(f"{_organization_label(org)}:")
        for service in org.services:
            print_fn(f"  {n}. {service.name} ({service.status})")
            n += 1

    if not _is_tty_stdin():
        print_fn(
            "Run this command in an interactive terminal to choose, "
            "or pass --service <name>."
        )
        return None

    try:
        answer = input(f"\nSelect service [1-{len(choices)}]: ").strip()
    except EOFError:
        return None
    try:
        index = int(answer) - 1
    except ValueError:
        print_fn("Invalid selection.")
        return None
    if index < 0 or index >= len(choices):
        print_fn("Invalid selection.")
        return None
    return choices[index]


__all__ = [
    "ServiceChoice",
    "render_service_organizations",
    "select_service_interactive",
    "service_choice_label",
]
