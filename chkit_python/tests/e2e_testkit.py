"""Shared test utilities for e2e tests.

Python-side port of the TS ``@chkit/clickhouse/e2e-testkit`` +
``packages/cli/src/test/e2e-testkit`` modules — see DRIFT for the parity note.

The Python port intentionally omits the TS ``runCli`` /
``runCliWithRetry`` / ``waitForCliJson`` helpers: Python's convention is
``typer.testing.CliRunner`` in-process invocation, not subprocess spawn, so
those helpers don't translate. What IS ported are the primitives that don't
depend on the runtime shape:

- ``LiveEnv`` — validated ClickHouse env resolution (hard-fail variant).
- ``resolve_live_env`` — port of TS ``getLiveEnv``: the local test stack
  (``LOCAL_STACK_ENV``) unless ``CLICKHOUSE_URL``/``CLICKHOUSE_HOST`` is set.
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
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar
from urllib.parse import urlparse

T = TypeVar("T")


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


# The ClickHouse in test/infra/docker-compose.yml, which `bun run infra:up` starts.
LOCAL_STACK_ENV = LiveEnv(
    clickhouse_url="http://localhost:8123",
    clickhouse_user="default",
    clickhouse_password="chkit-ci",
    clickhouse_database="default",
)


def get_required_env() -> LiveEnv:
    """Read + validate ClickHouse env vars. Raises on missing URL/password.

    The remote-target half of TS ``getLiveEnv`` (formerly ``getRequiredEnv``).
    Tests use :func:`resolve_live_env`, which falls back to the local test
    stack when no target is set.
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
    """Read the ClickHouse target from env vars, like TS ``getLiveEnv``.

    Without ``CLICKHOUSE_URL`` or ``CLICKHOUSE_HOST`` the tests run against the
    local test stack (``test/infra``, started by ``bun run infra:up``):
    :data:`LOCAL_STACK_ENV`. A remote target must also set
    ``CLICKHOUSE_PASSWORD``; a missing one raises instead of silently
    connecting without credentials.
    """
    host = (os.environ.get("CLICKHOUSE_HOST") or "").strip()
    url = (os.environ.get("CLICKHOUSE_URL") or "").strip()
    if not url and host:
        url = f"https://{host}"
    if not url:
        return LOCAL_STACK_ENV
    return get_required_env()


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
    """Return ``value`` wrapped in backticks, escaping backslashes and backticks.

    Direct port of TS ``quoteIdent`` (core ``quoteIdentifier``): the name can
    never terminate the quoted identifier early, and the escaping matches
    ClickHouse's own formatting of quoted identifiers. Use when building DDL by
    string concatenation in a test.
    """
    escaped = value.replace("\\", "\\\\").replace("`", "\\`")
    return f"`{escaped}`"


def _random_suffix() -> str:
    """Return an 8-hex-digit random suffix (32 bits).

    TS uses ``Math.floor(Math.random() * 100000)``. Five decimal digits made
    names collide when many are built within the same millisecond (birthday
    bound: ~5% for 100 calls), so the Python port uses a wider suffix.
    """
    return secrets.token_hex(4)


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


def poll_until(
    read: Callable[[], T],
    predicate: Callable[[T], bool],
    *,
    timeout: float = 30.0,
    interval: float = 0.5,
) -> T:
    """Re-read ``read()`` until ``predicate`` accepts its value or ``timeout`` elapses.

    Port of TS ``pollUntil``. Running out of time returns the last observed
    value instead of raising, so the caller's own assert reports the real diff.
    A read that keeps raising until the deadline re-raises its last error.

    Put the whole observation inside ``read``: on multi-replica services each
    attempt may land on a different replica, so a one-off preparation step
    can't be relied on.
    """
    deadline = time.monotonic() + timeout
    while True:
        try:
            value = read()
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(interval)
            continue
        if predicate(value) or time.monotonic() >= deadline:
            return value
        time.sleep(interval)


# Errors a statement gets when it lands on a replica that hasn't applied an
# earlier DDL yet. Such a failure changes nothing, so the statement can run again.
_NOT_YET_VISIBLE_ERRORS = ("UNKNOWN_TABLE",)


def run_once_visible(run: Callable[[], T], *, timeout: float = 30.0, interval: float = 0.5) -> T:
    """Run a statement that needs an object an earlier DDL created.

    On a multi-replica service (ObsessionDB) each request may land on a
    different replica, and one that hasn't applied the CREATE yet answers
    ``UNKNOWN_TABLE`` even after ``wait_for_table`` saw the table on another
    one. Such a failure changes nothing, so the statement is re-run until the
    replica serving it sees the object; any other error raises at once.
    """
    deadline = time.monotonic() + timeout
    while True:
        try:
            return run()
        except Exception as error:
            if time.monotonic() >= deadline or not any(
                code in str(error) for code in _NOT_YET_VISIBLE_ERRORS
            ):
                raise
        time.sleep(interval)


def wait_for_table_on_every_replica(
    client: Any, database: str, table: str, *, timeout: float = 30.0
) -> None:
    """Poll until every replica of the service lists ``database.table``.

    ``wait_for_table`` sees one replica per attempt, so on a multi-replica
    service (ObsessionDB) the next request can still land on one that has not
    applied the CREATE. When the server names a cluster for parallel replicas,
    count the replicas listing the table through ``clusterAllReplicas`` until
    all of them do; otherwise (a single node) ``system.tables`` is enough.
    ``client.query(sql)`` must return an object with ``rows``.
    """
    cluster_rows = client.query(
        "SELECT getSetting('cluster_for_parallel_replicas') AS cluster"
    ).rows
    cluster = str(cluster_rows[0]["cluster"]) if cluster_rows else ""
    db = database.replace("\\", "\\\\").replace("'", "\\'")
    name = table.replace("\\", "\\\\").replace("'", "\\'")
    if cluster:
        quoted_cluster = cluster.replace("\\", "\\\\").replace("'", "\\'")
        sql = (
            f"SELECT (SELECT count() FROM clusterAllReplicas('{quoted_cluster}', system.one))"
            f" AS replicas, (SELECT count() FROM clusterAllReplicas('{quoted_cluster}', "
            f"system.tables) WHERE database = '{db}' AND name = '{name}') AS listed"
        )
    else:
        sql = (
            "SELECT 1 AS replicas, count() AS listed FROM system.tables "
            f"WHERE database = '{db}' AND name = '{name}'"
        )
    row = poll_until(
        lambda: client.query(sql).rows[0],
        lambda value: int(value["listed"]) >= int(value["replicas"]),
        timeout=timeout,
    )
    if int(row["listed"]) < int(row["replicas"]):
        msg = (
            f"{database}.{table} is listed on {row['listed']} of "
            f"{row['replicas']} replicas after {timeout}s"
        )
        raise AssertionError(msg)


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
    "LOCAL_STACK_ENV",
    "LiveEnv",
    "create_journal_table_name",
    "create_prefix",
    "create_run_tag",
    "format_test_diagnostic",
    "get_required_env",
    "live_env_to_client_kwargs",
    "poll_until",
    "quote_ident",
    "resolve_live_env",
    "run_once_visible",
    "wait_for_table_on_every_replica",
]
