"""Interactive ObsessionDB onboarding wizard (called by ``chkit init``).

1:1 port of ``packages/plugin-obsessiondb/src/onboarding/index.ts``.

Three connect paths sharing one entry point:

- ``claim`` — passwordless signup + claim a free dev instance
- ``account`` — device-code login for existing users
- ``clickhouse`` — bring-your-own ClickHouse (just remind the user
  to set ``CLICKHOUSE_URL``)
- ``later`` — skip and print next-steps

``ensure_obsessiondb_plugin_in_source`` text-rewrites
``clickhouse.config.py`` to register the ``obsessiondb()`` plugin so
``Shared*`` engine rewriting + remote executor wiring take effect on the
next run.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Final, Literal

from chkit_plugin_obsessiondb.auth_login import run_login
from chkit_plugin_obsessiondb.auth_signup import (
    SignupOptions,
    run_signup,
)
from chkit_plugin_obsessiondb.credentials import (
    load_credentials,
    resolve_base_url,
)
from chkit_plugin_obsessiondb.service_claim import run_claim


class ConnectChoice(StrEnum):
    """Pre-selected branch of the onboarding wizard."""

    claim = "claim"
    account = "account"
    clickhouse = "clickhouse"
    later = "later"


PackageManager = Literal["pip", "uv", "poetry", "rye", "uvx", "pipx"]


@dataclass(frozen=True, slots=True)
class OnboardingOptions:
    config_path: Path
    connect: ConnectChoice | None = None
    email: str | None = None
    code: str | None = None
    org_name: str | None = None
    skip: bool = False
    # Python equivalent of the TS ``packageManager`` field: used to prefix the
    # ``chkit ...`` commands in the next-steps output so users invoking via uv /
    # uvx / pipx see the right runner. ``None`` (default) prints bare ``chkit``
    # which works for any active venv.
    package_manager: PackageManager | None = None


def _runner_for(package_manager: PackageManager | None) -> str:
    """Map a package manager to its run-prefix word for one-off chkit calls.

    Mirrors TS ``runnerFor``. Python-specific values:
    - ``uv`` / ``uvx``  → ``uvx``  (uv's `dlx`-equivalent)
    - ``pipx``           → ``pipx run``
    - ``poetry``         → ``poetry run``
    - ``rye``            → ``rye run``
    - ``pip`` / ``None`` → bare ``chkit`` (assume active venv).
    """
    if package_manager in {"uv", "uvx"}:
        return "uvx"
    if package_manager == "pipx":
        return "pipx run"
    if package_manager == "poetry":
        return "poetry run chkit"
    if package_manager == "rye":
        return "rye run chkit"
    return ""


_IMPORT_LINE: Final[str] = (
    "from chkit_plugin_obsessiondb import obsessiondb"
)


def _is_tty() -> bool:
    return bool(getattr(sys.stdout, "isatty", lambda: False)()) and bool(
        getattr(sys.stdin, "isatty", lambda: False)()
    )


# ---------- runbook / next-steps ----------


def connect_runbook_lines() -> list[str]:
    return [
        "No TTY detected — connect a database non-interactively by running one of:",
        "",
        "  • Free ObsessionDB dev instance (2 steps, needs the emailed code):",
        "      chkit plugin obsessiondb signup --email <you@example.com>",
        "      chkit plugin obsessiondb signup --email <you@example.com> --code <CODE>",
        "      chkit plugin obsessiondb service claim",
        "",
        "  • Existing ObsessionDB account:",
        "      chkit plugin obsessiondb login",
        "",
        "  • Existing ClickHouse instance:",
        "      set CLICKHOUSE_URL (and CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DB)",
    ]


def _print_connect_runbook() -> None:
    for line in connect_runbook_lines():
        print(line)


def _print_next_steps(package_manager: PackageManager | None = None) -> None:
    runner = _runner_for(package_manager)
    cmd = f"{runner} chkit" if runner else "chkit"
    print("Next steps:")
    print("  1. Edit your schema under src/db/schema/.")
    print(f"  2. Run: {cmd} generate --name init")
    print(f"  3. Run: {cmd} migrate --apply")
    print(f"  4. Run: {cmd} status")


# ---------- config file rewrite ----------


@dataclass(frozen=True, slots=True)
class EnsurePluginResult:
    source: str
    changed: bool


_OBSESSIONDB_CALL_RE = re.compile(r"obsessiondb\s*\(")
_IMPORT_RE = re.compile(r"^import .*$|^from .* import .*$", re.MULTILINE)
_PLUGINS_ARRAY_RE = re.compile(r'"plugins"\s*:\s*\[')


def ensure_obsessiondb_plugin_in_source(source: str) -> EnsurePluginResult:
    """Add ``obsessiondb()`` to a config's ``plugins`` list (and its import) if absent.

    Pure / text-based so it's testable without writing to disk.
    """
    if _OBSESSIONDB_CALL_RE.search(source):
        return EnsurePluginResult(source=source, changed=False)

    plugins_match = _PLUGINS_ARRAY_RE.search(source)
    if plugins_match is None:
        return EnsurePluginResult(source=source, changed=False)

    next_source = source
    if "chkit_plugin_obsessiondb" not in next_source:
        next_source = _insert_import(next_source, _IMPORT_LINE)
    next_source = _PLUGINS_ARRAY_RE.sub(
        '"plugins": [\n            obsessiondb(),', next_source, count=1
    )
    return EnsurePluginResult(source=next_source, changed=True)


def _insert_import(source: str, import_line: str) -> str:
    """Insert ``import_line`` after the last existing import statement."""
    imports = list(_IMPORT_RE.finditer(source))
    if not imports:
        return f"{import_line}\n{source}"
    last = imports[-1]
    insert_at = last.end()
    return f"{source[:insert_at]}\n{import_line}{source[insert_at:]}"


def _ensure_obsessiondb_plugin(config_path: Path) -> None:
    """Read → text-rewrite → write the config. Silent if file is missing."""
    try:
        source = config_path.read_text(encoding="utf-8")
    except OSError:
        return
    result = ensure_obsessiondb_plugin_in_source(source)
    if not result.changed:
        if _OBSESSIONDB_CALL_RE.search(source) is None:
            print(
                "Could not auto-register the obsessiondb() plugin. "
                "Add it to the `plugins` list in clickhouse.config.py."
            )
        return
    config_path.write_text(result.source, encoding="utf-8")


# ---------- interactive prompt ----------


def _select_choice() -> ConnectChoice:
    print("\nHow do you want to connect to a database?")
    print("  1) Claim a free ObsessionDB dev instance  (email code, ready in seconds)")
    print("  2) I already have an ObsessionDB account  (log in and pick a service)")
    print("  3) I already have a ClickHouse instance   (connect with env vars)")
    print("  4) Configure later")
    try:
        answer = input("\nEnter 1-4: ").strip()
    except EOFError:
        return ConnectChoice.later
    mapping = {
        "1": ConnectChoice.claim,
        "2": ConnectChoice.account,
        "3": ConnectChoice.clickhouse,
        "4": ConnectChoice.later,
    }
    return mapping.get(answer, ConnectChoice.later)


def _resolve_choice(options: OnboardingOptions) -> ConnectChoice:
    if options.skip:
        return ConnectChoice.later
    if options.connect is not None:
        return options.connect
    if not _is_tty():
        return ConnectChoice.later
    return _select_choice()


# ---------- run_onboarding entry point ----------


def _print_obj(value: object) -> None:
    print(value if isinstance(value, str) else str(value))


def run_onboarding(
    *,
    config_path: Path,
    connect: ConnectChoice | None = None,
    email: str | None = None,
    code: str | None = None,
    org_name: str | None = None,
    skip: bool = False,
    package_manager: PackageManager | None = None,
) -> None:
    """Top-level wizard called by ``chkit init`` and ``create-chkit``."""
    options = OnboardingOptions(
        config_path=config_path,
        connect=connect,
        email=email,
        code=code,
        org_name=org_name,
        skip=skip,
        package_manager=package_manager,
    )

    # Non-interactive + no explicit choice → print every runbook + next steps.
    if not options.skip and options.connect is None and not _is_tty():
        _print_connect_runbook()
        print("")
        _print_next_steps(options.package_manager)
        return

    choice = _resolve_choice(options)
    if choice == ConnectChoice.later:
        _print_next_steps(options.package_manager)
        return

    # Every connected path keeps obsessiondb() registered.
    _ensure_obsessiondb_plugin(config_path)

    base_url = resolve_base_url()

    if choice == ConnectChoice.clickhouse:
        print(
            "Set CLICKHOUSE_URL (and CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / "
            "CLICKHOUSE_DB) for your instance."
        )
        _print_next_steps(options.package_manager)
        return

    if choice == ConnectChoice.account:
        run_login(base_url, config_path, print)
        _print_next_steps(options.package_manager)
        return

    # Falls through to the "claim a free instance" path.
    signup_code = run_signup(
        base_url,
        _print_obj,
        SignupOptions(email=email, code=code, org_name=org_name),
    )
    if signup_code != 0:
        msg = (
            "Signup did not complete. Run `chkit plugin obsessiondb signup` "
            "to finish, then `chkit plugin obsessiondb service claim`."
        )
        raise RuntimeError(msg)
    creds = load_credentials()
    # signup returned 0 but no creds persisted → two-step pause (code sent, user
    # needs to re-run with --code). Not a failure, just exit cleanly.
    if creds is None:
        return
    claim_code = run_claim(creds, config_path, _print_obj)
    if claim_code != 0:
        msg = (
            "Could not claim a free instance. Run "
            "`chkit plugin obsessiondb service claim` to retry."
        )
        raise RuntimeError(msg)
    _print_next_steps(options.package_manager)
