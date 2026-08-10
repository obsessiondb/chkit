"""Structured ``--json`` envelopes for the obsessiondb plugin commands.

1:1 port of ``packages/plugin-obsessiondb/src/json-envelope.ts``. Centralises
the shape of every JSON payload the plugin emits so consumers (jq, CI
scripts) can rely on a stable schema across chkit versions.

Every envelope carries:

- ``command``: the canonical CLI command id (e.g. ``"obsessiondb whoami"``).
- ``schemaVersion``: ``JSON_CONTRACT_VERSION`` — bump when the envelope
  shape changes incompatibly.

Then either:

- A *next* envelope (``status`` + optional ``next`` action descriptor) for
  intermediate states the user must act on.
- An *error* envelope (``ok: False`` + ``error: {code, message}``) for
  terminal failures.
- A *list/data* envelope for queries that return a payload.
"""

from __future__ import annotations

from typing import Any, Final, Literal, TypedDict

JSON_CONTRACT_VERSION: Final[int] = 1


class _ErrorBody(TypedDict):
    code: str
    message: str


class ErrorEnvelope(TypedDict):
    command: str
    schemaVersion: int
    ok: Literal[False]
    error: _ErrorBody


class WhoamiEnvelope(TypedDict):
    command: str
    schemaVersion: int
    status: Literal["logged_in"]
    email: str
    next: None


class ServiceListEntry(TypedDict):
    organization: str
    slug: str
    name: str
    selected: bool


class ServiceListEnvelope(TypedDict):
    command: str
    schemaVersion: int
    status: Literal["ok"]
    services: list[ServiceListEntry]


def error_envelope(command: str, code: str, message: str) -> ErrorEnvelope:
    """Terminal failure envelope. Keeps ``--json`` pipes valid on error paths."""
    return {
        "command": command,
        "schemaVersion": JSON_CONTRACT_VERSION,
        "ok": False,
        "error": {"code": code, "message": message},
    }


def whoami_envelope(*, email: str, name: str | None = None) -> WhoamiEnvelope:
    """``whoami`` envelope for an authenticated session: terminal, no next action.

    The TS envelope drops ``name`` from the payload (only ``email`` is
    surfaced); we match that. ``name`` is accepted for forward-compat
    in case TS later adds it.
    """
    _ = name  # kept for forward-compat; not currently emitted
    return {
        "command": "obsessiondb whoami",
        "schemaVersion": JSON_CONTRACT_VERSION,
        "status": "logged_in",
        "email": email,
        "next": None,
    }


def service_list_envelope(
    services: list[ServiceListEntry],
) -> ServiceListEnvelope:
    """``service list`` envelope: one object with a services array."""
    return {
        "command": "obsessiondb service list",
        "schemaVersion": JSON_CONTRACT_VERSION,
        "status": "ok",
        "services": services,
    }


def envelope(command: str, status: str, **extra: Any) -> dict[str, Any]:
    """Generic next-envelope builder for status payloads beyond the typed ones."""
    return {
        "command": command,
        "schemaVersion": JSON_CONTRACT_VERSION,
        "status": status,
        **extra,
    }


__all__ = [
    "JSON_CONTRACT_VERSION",
    "ErrorEnvelope",
    "ServiceListEntry",
    "ServiceListEnvelope",
    "WhoamiEnvelope",
    "envelope",
    "error_envelope",
    "service_list_envelope",
    "whoami_envelope",
]
