"""Shared test utilities for e2e tests.

Python-side port of the TS ``@chkit/clickhouse/e2e-testkit`` +
``packages/cli/src/test/e2e-testkit`` modules — see DRIFT for the parity note.

The Python port intentionally omits the TS ``runCli`` /
``runCliWithRetry`` / ``waitForCliJson`` helpers: Python's convention is
``typer.testing.CliRunner`` in-process invocation, not subprocess spawn, so
those helpers don't translate. What IS ported are the primitives that don't
depend on the runtime shape:

- ``LiveEnv`` — validated ClickHouse env resolution (hard-fail variant).
- ``resolve_live_env`` — soft-default variant used by conftest for the
  "Docker on localhost" dev workflow.
- ``create_prefix`` / ``create_journal_table_name`` / ``create_run_tag`` —
  unique name builders for isolating parallel runs.
- ``quote_ident`` — backtick identifier quoter for hand-built DDL.
- ``format_test_diagnostic`` — structured failure message for CLI results.

Live-cluster e2e tests that grow a subprocess pattern in Python can add
CLI-runner helpers on top of this module; the naming/env primitives stay
runtime-agnostic here.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlparse


@dataclass(frozen=True)
class LiveEnv:
    """Resolved ClickHouse connection info for e2e tests.

    Mirrors the TS ``LiveEnv`` interface. Immutable so it can be threaded
    through fixtures without copy-on-mutate surprises.
    """

    clickhouse_url: str
    clickhouse_user: str
    clickhouse_password: str
    clickhouse_database: str


def get_required_env() -> LiveEnv:
    """Read + validate ClickHouse env vars. Raises on missing URL/password.

    Direct port of TS ``getRequiredEnv``. Use this when a test MUST talk to a
    live ClickHouse (e.g. a cluster e2e); use :func:`resolve_live_env` for
    tests that should default to the local dev docker.
    """
    host = (os.environ.get("CLICKHOUSE_HOST") or "").strip()
    url = (os.environ.get("CLICKHOUSE_URL") or "").strip()
    if not url and host:
        url = f"https://{host}"
    user = (os.environ.get("CLICKHOUSE_USER") or "").strip() or "default"
    password = (os.environ.get("CLICKHOUSE_PASSWORD") or "").strip()
    database = (os.environ.get("CLICKHOUSE_DB") or "").strip() or "default"

    if not url:
        msg = "Missing CLICKHOUSE_URL or CLICKHOUSE_HOST"
        raise RuntimeError(msg)
    if not password:
        msg = "Missing CLICKHOUSE_PASSWORD"
        raise RuntimeError(msg)

    return LiveEnv(
        clickhouse_url=url,
        clickhouse_user=user,
        clickhouse_password=password,
        clickhouse_database=database,
    )


def resolve_live_env() -> LiveEnv:
    """Read ClickHouse env vars with dev-friendly defaults.

    Python divergence from TS ``getRequiredEnv``: the user's local dev workflow
    is "Docker on localhost with default config", so fall back to
    ``http://localhost:8123`` / empty password when nothing is set instead of
    hard-failing. The TS hard-fail variant is available via
    :func:`get_required_env` for tests that need strict behaviour.
    """
    host = (os.environ.get("CLICKHOUSE_HOST") or "").strip()
    url = (os.environ.get("CLICKHOUSE_URL") or "").strip()
    if not url and host:
        url = f"https://{host}"
    if not url:
        url = "http://localhost:8123"

    user = (os.environ.get("CLICKHOUSE_USER") or "").strip() or "default"
    password = os.environ.get("CLICKHOUSE_PASSWORD")
    if password is None:
        password = ""
    database = (os.environ.get("CLICKHOUSE_DB") or "").strip() or "default"

    return LiveEnv(
        clickhouse_url=url,
        clickhouse_user=user,
        clickhouse_password=password,
        clickhouse_database=database,
    )


def live_env_to_client_kwargs(env: LiveEnv) -> dict[str, Any]:
    """Convert a :class:`LiveEnv` to ``clickhouse_connect.get_client`` kwargs.

    The TS testkit exposes ``createLiveExecutor(env)`` returning a
    ClickHouseExecutor — that shape is bound to the TS clickhouse-connect
    wrapper. Python's clickhouse-connect takes ``host/port/secure/...``, so we
    parse the URL here and hand back a kwargs dict callers can splat.
    """
    parsed = urlparse(env.clickhouse_url)
    host_only = parsed.hostname or "localhost"
    secure = parsed.scheme == "https"
    port = parsed.port if parsed.port is not None else (8443 if secure else 8123)
    return {
        "host": host_only,
        "port": port,
        "secure": secure,
        "username": env.clickhouse_user,
        "password": env.clickhouse_password,
        "database": env.clickhouse_database,
    }


def quote_ident(value: str) -> str:
    """Return ``value`` wrapped in backticks with any embedded backticks doubled.

    Direct port of TS ``quoteIdent``. Use when building DDL by string
    concatenation in a test — the SQL renderer in production code has its own
    quoting; this is for hand-built statements only.
    """
    return f"`{value.replace('`', '``')}`"


def _random_suffix() -> str:
    """Return a hex suffix unique per call.

    ``secrets.randbelow`` gives us cryptographic-quality randomness without
    the seedability of ``random`` — collisions across parallel workers are
    effectively impossible even without process-pid entropy mixed in.
    """
    return f"{secrets.randbelow(100_000):05d}"


def create_run_tag() -> str:
    """Return a ``<pid>_<ms-since-epoch>_<rand>`` tag unique per invocation.

    Mirrors TS ``createRunTag``. Useful as a suffix on transient objects that
    outlive a single test (e.g. a fixture-scoped database name).
    """
    return f"{os.getpid()}_{int(time.time() * 1000)}_{_random_suffix()}"


def create_prefix(label: str = "test") -> str:
    """Return ``chkit_e2e_<label>_<ms>_<rand>_`` — matches TS ``createPrefix``.

    Suffix with the object name to isolate parallel test workers on a shared
    ClickHouse. The trailing ``_`` mirrors the TS behavior — callers append
    the base name directly.
    """
    return f"chkit_e2e_{label}_{int(time.time() * 1000)}_{_random_suffix()}_"


def create_journal_table_name(label: str) -> str:
    """Return ``_chkit_migrations_<label>_<runTag>``.

    Mirrors TS ``createJournalTableName``: prefers ``GITHUB_RUN_ID`` (so CI
    reruns can be correlated) and falls back to ``<ms>_<rand>``. Used to point
    ``CHKIT_JOURNAL_TABLE`` at a per-test journal so parallel tests don't
    contend on the shared ``_chkit_migrations`` table.
    """
    run_tag = (os.environ.get("GITHUB_RUN_ID") or "").strip()
    if not run_tag:
        run_tag = f"{int(time.time() * 1000)}_{_random_suffix()}"
    return f"_chkit_migrations_{label}_{run_tag}"


class _CliResultLike(Protocol):
    """Structural type covering ``typer.testing.Result`` and ad-hoc CLI results.

    Anything with ``exit_code`` + ``output`` fits — that's what the diagnostic
    formatter needs. Defined as a Protocol so callers don't have to import
    typer just to satisfy a type hint.
    """

    exit_code: int
    output: str


def format_test_diagnostic(
    label: str,
    result: _CliResultLike,
    extra: dict[str, Any] | None = None,
) -> str:
    """Format a CLI failure for a test assertion message.

    Mirrors TS ``formatTestDiagnostic``. Python's ``typer.testing.Result``
    combines stdout+stderr into ``.output``, so unlike TS we only render one
    output block instead of two.
    """
    parts = [
        f"--- {label} ---",
        f"exitCode: {result.exit_code}",
        f"output:\n{result.output}",
    ]
    if extra:
        parts.append(f"extra: {json.dumps(extra, indent=2, default=repr)}")
    return "\n".join(parts)


__all__ = [
    "LiveEnv",
    "create_journal_table_name",
    "create_prefix",
    "create_run_tag",
    "format_test_diagnostic",
    "get_required_env",
    "live_env_to_client_kwargs",
    "quote_ident",
    "resolve_live_env",
]
