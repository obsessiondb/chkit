"""Device-code login + logout + whoami flows.

1:1 port of ``packages/plugin-obsessiondb/src/auth/login.ts``.
"""

from __future__ import annotations

import contextlib
import platform
import subprocess
from collections.abc import Callable
from pathlib import Path

from chkit_plugin_obsessiondb.api_client import (
    get_session,
    poll_device_token,
    request_device_code,
)
from chkit_plugin_obsessiondb.credentials import (
    Credentials,
    clear_credentials,
    load_credentials,
    save_credentials,
)
from chkit_plugin_obsessiondb.json_envelope import (
    error_envelope,
    whoami_envelope,
)


def _open_browser(url: str) -> None:
    """Try to open ``url`` in the user's default browser. Silent on failure."""
    if platform.system() == "Darwin":
        cmd = ["open", url]
    elif platform.system() == "Windows":
        cmd = ["cmd.exe", "/c", "start", "", url]
    else:
        cmd = ["xdg-open", url]
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def run_login(
    base_url: str,
    config_path: Path,
    print_fn: Callable[[str], None],
) -> int:
    """Device-code login. Returns exit code (0 on success).

    If an existing token still resolves a session, we just confirm and exit.
    Otherwise we run the full RFC 8628 device-code dance: request → open
    browser → poll → save → confirm session.
    """
    _ = config_path  # used by promptServiceSelection in TS; service flow ports next
    existing = load_credentials()
    if existing is not None:
        try:
            session = get_session(existing.base_url, existing.access_token)
        except Exception:
            clear_credentials()
        else:
            print_fn(f"Already logged in as {session.user.email}")
            return 0

    device = request_device_code(base_url)
    print_fn(f"\nOpen this URL in your browser:\n  {device.verification_uri_complete}\n")
    print_fn(f"Enter code: {device.user_code}\n")
    _open_browser(device.verification_uri_complete)
    print_fn("Waiting for authorization...")

    token = poll_device_token(
        base_url,
        device.device_code,
        interval=float(device.interval),
        expires_in=float(device.expires_in),
    )
    save_credentials(Credentials(access_token=token, base_url=base_url))
    session = get_session(base_url, token)
    print_fn(f"Logged in as {session.user.email}")
    return 0


def run_logout(print_fn: Callable[[str], None]) -> int:
    """Remove stored credentials. Returns 0 always."""
    had = clear_credentials()
    print_fn("Logged out." if had else "No active session.")
    return 0


def run_whoami(
    print_fn: Callable[[object], None],
    *,
    json_mode: bool = False,
) -> int:
    """Print the current user or a friendly error envelope.

    JSON envelopes mirror TS ``json-envelope.ts``:
    - logged-in:    ``{command, schemaVersion, status: 'logged_in', email, next: null}``
    - not_logged_in / session_expired: ``error_envelope`` shape.
    """
    creds = load_credentials()
    if creds is None:
        message = "Not logged in. Run `chkit obsessiondb login` to authenticate."
        print_fn(
            error_envelope("obsessiondb whoami", "not_logged_in", message)
            if json_mode
            else message
        )
        return 1

    try:
        session = get_session(creds.base_url, creds.access_token)
    except Exception:
        clear_credentials()
        message = "Session expired. Run `chkit obsessiondb login` to re-authenticate."
        print_fn(
            error_envelope("obsessiondb whoami", "session_expired", message)
            if json_mode
            else message
        )
        return 1

    if json_mode:
        print_fn(
            whoami_envelope(email=session.user.email, name=session.user.name)
        )
    else:
        print_fn(f"Logged in as {session.user.email} ({session.user.name})")
    return 0
