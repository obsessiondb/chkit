"""Passwordless email + OTP signup/login flow.

1:1 port of ``packages/plugin-obsessiondb/src/auth/signup.ts``.

Three modes share one path:

- Interactive (TTY): send → prompt for code → verify.
- Two-step CI: ``--email --request-only`` then ``--email --code <CODE>``.
- Scripted: pass ``--email`` + ``--code`` together; presence of ``--code``
  skips the re-send (the OTP would be invalidated).
"""

from __future__ import annotations

import re
import secrets
import string
import sys
from collections.abc import Callable
from dataclasses import dataclass

from chkit_plugin_obsessiondb.api_client import (
    OtpRateLimitError,
    create_organization,
    get_session,
    send_verification_otp,
    set_active_organization,
    verify_otp,
)
from chkit_plugin_obsessiondb.credentials import (
    Credentials,
    save_credentials,
)

_ORG_NAME_MAX_LEN = 32
_OTP_LEN = 6


@dataclass(frozen=True, slots=True)
class SignupOptions:
    """Inputs for ``run_signup`` — mirrors TS ``SignupOptions``."""

    email: str | None = None
    code: str | None = None
    org_name: str | None = None
    request_only: bool = False
    json_mode: bool = False


def _is_tty_stdin() -> bool:
    return bool(getattr(sys.stdin, "isatty", lambda: False)())


def _prompt_email(print_fn: Callable[[object], None], *, json_mode: bool) -> str | None:
    if not _is_tty_stdin():
        if json_mode:
            print_fn(
                {
                    "command": "obsessiondb signup",
                    "ok": False,
                    "error": {
                        "code": "email_required",
                        "message": (
                            "No email provided. In non-interactive environments, "
                            "rerun with --email <you@example.com>."
                        ),
                    },
                }
            )
        else:
            for line in signup_email_runbook():
                print_fn(line)
        return None
    try:
        value = input("Enter your email to sign up or log in: ").strip()
    except EOFError:
        return None
    if "@" not in value:
        print_fn("Enter a valid email address.")
        return None
    return value


def _prompt_code(print_fn: Callable[[object], None], *, json_mode: bool) -> str | None:
    if not _is_tty_stdin():
        message = "No code provided. Re-run with --code <code> in non-interactive environments."
        if json_mode:
            print_fn(
                {
                    "command": "obsessiondb signup",
                    "ok": False,
                    "error": {"code": "code_required", "message": message},
                }
            )
        else:
            print_fn(message)
        return None
    try:
        value = input("Enter the 6-digit code from your email: ").strip()
    except EOFError:
        return None
    if not re.fullmatch(rf"\d{{{_OTP_LEN}}}", value):
        print_fn(f"Enter the {_OTP_LEN}-digit code.")
        return None
    return value


def signup_email_runbook() -> list[str]:
    """Full two-step recipe printed when no email is available non-interactively."""
    return [
        "No email provided. In non-interactive environments, sign up in two steps:",
        "  1. chkit obsessiondb signup --email you@example.com --request-only",
        "     # sends a 6-digit code",
        "  2. chkit obsessiondb signup --email you@example.com --code 123456",
        "     # verifies and signs in",
        "Then claim a service: chkit obsessiondb service claim",
    ]


def verify_step_hint(email: str) -> list[str]:
    return [
        f"Next: chkit obsessiondb signup --email {email} --code <CODE>",
        "Then: chkit obsessiondb service claim",
    ]


def derive_org_name(email: str) -> str:
    """Drop the ``+subaddress`` and any non-display chars from the email local-part."""
    local = email.split("@", 1)[0].split("+", 1)[0]
    cleaned = re.sub(r"[^a-z0-9._-]+", "", local.strip().lower())
    return cleaned or "playground"


def slugify_org_name(name: str) -> str:
    """Slug + random suffix so two machines can't collide on the same org name."""
    base = re.sub(r"[^a-z0-9]+", "-", name.lower())
    base = re.sub(r"^-|-$", "", base)[:_ORG_NAME_MAX_LEN] or "playground"
    alphabet = string.ascii_lowercase + string.digits
    suffix = "".join(secrets.choice(alphabet) for _ in range(6))
    return f"{base}-{suffix}"


def _ensure_active_organization(
    base_url: str, token: str, *, email: str, org_name: str | None
) -> str | None:
    """Auto-create a personal org when the session doesn't have one yet."""
    session = get_session(base_url, token)
    if session.session is not None and session.session.active_organization_id:
        return None
    name = org_name or derive_org_name(email)
    slug = slugify_org_name(name)
    created = create_organization(base_url, token, name=name, slug=slug)
    org_id = str(created.get("id", ""))
    if org_id:
        set_active_organization(base_url, token, org_id)
    return name


def run_signup(  # noqa: PLR0912
    base_url: str,
    print_fn: Callable[[object], None],
    options: SignupOptions | None = None,
) -> int:
    if options is None:
        options = SignupOptions()
    json_mode = options.json_mode
    email = options.email or _prompt_email(print_fn, json_mode=json_mode)
    if email is None:
        return 1

    # A supplied code means this is the verify step of a prior request — re-sending
    # would invalidate the code the caller is about to submit.
    if options.code is None:
        try:
            send_verification_otp(base_url, email)
        except OtpRateLimitError as error:
            if json_mode:
                print_fn(
                    {
                        "command": "obsessiondb signup",
                        "ok": False,
                        "error": {
                            "code": "otp_rate_limited",
                            "message": str(error),
                        },
                    }
                )
            else:
                print_fn(str(error))
            return 1

        if not json_mode:
            print_fn(f"We sent a 6-digit code to {email}.")

        if options.request_only or not _is_tty_stdin():
            if json_mode:
                print_fn(
                    {
                        "command": "obsessiondb signup",
                        "ok": True,
                        "status": "otp_sent",
                        "email": email,
                    }
                )
            else:
                for line in verify_step_hint(email):
                    print_fn(line)
            return 0

    code = options.code or _prompt_code(print_fn, json_mode=json_mode)
    if code is None:
        return 1

    result = verify_otp(base_url, email, code)
    save_credentials(Credentials(access_token=result.token, base_url=base_url))

    created = _ensure_active_organization(
        base_url, result.token, email=email, org_name=options.org_name
    )
    if json_mode:
        print_fn(
            {
                "command": "obsessiondb signup",
                "ok": True,
                "status": "verified",
                "email": email,
            }
        )
    elif created is not None:
        print_fn(f'Created organization "{created}".')
        print_fn(f"Signed in as {result.user.email}.")
    else:
        print_fn(f"Welcome back, {result.user.email}.")

    return 0
