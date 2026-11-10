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

from typing import Any, Final, Literal, NotRequired, TypedDict

JSON_CONTRACT_VERSION: Final[int] = 1

# The commands a non-interactive caller runs next, shared by the signup
# runbook (auth_signup.py) and the envelopes below, as in TS.
SIGNUP_EMAIL_COMMAND: Final[str] = "chkit obsessiondb signup --email <you@example.com>"
CLAIM_COMMAND: Final[str] = "chkit obsessiondb service claim"

_SIGNUP_COMMAND_ID: Final[str] = "obsessiondb signup"


def verify_code_command(email: str) -> str:
    """Step 2 of the non-interactive signup: verify the emailed code."""
    return f"chkit obsessiondb signup --email {email} --code <CODE>"


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


class NextAction(TypedDict):
    """What a non-interactive caller runs next: the input it needs and the command."""

    needs: str
    command: str


class SignupEnvelope(TypedDict):
    command: str
    schemaVersion: int
    status: Literal["no_email", "otp_sent", "verified"]
    email: NotRequired[str]
    next: NextAction


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


def no_email_envelope() -> SignupEnvelope:
    """signup without an email in a non-interactive run: the caller must pass ``--email``."""
    return {
        "command": _SIGNUP_COMMAND_ID,
        "schemaVersion": JSON_CONTRACT_VERSION,
        "status": "no_email",
        "next": {"needs": "email", "command": SIGNUP_EMAIL_COMMAND},
    }


def otp_sent_envelope(email: str) -> SignupEnvelope:
    """signup sent a code and paused: the caller must run again with ``--code``."""
    return {
        "command": _SIGNUP_COMMAND_ID,
        "schemaVersion": JSON_CONTRACT_VERSION,
        "status": "otp_sent",
        "email": email,
        "next": {"needs": "code", "command": verify_code_command(email)},
    }


def verified_envelope(email: str) -> SignupEnvelope:
    """signup verified and signed in: the caller can now claim an instance."""
    return {
        "command": _SIGNUP_COMMAND_ID,
        "schemaVersion": JSON_CONTRACT_VERSION,
        "status": "verified",
        "email": email,
        "next": {"needs": "claim", "command": CLAIM_COMMAND},
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
    "CLAIM_COMMAND",
    "JSON_CONTRACT_VERSION",
    "SIGNUP_EMAIL_COMMAND",
    "ErrorEnvelope",
    "NextAction",
    "ServiceListEntry",
    "ServiceListEnvelope",
    "SignupEnvelope",
    "WhoamiEnvelope",
    "envelope",
    "error_envelope",
    "no_email_envelope",
    "otp_sent_envelope",
    "service_list_envelope",
    "verified_envelope",
    "verify_code_command",
    "whoami_envelope",
]
