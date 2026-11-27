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

import base64
import json
import os
import random
import secrets
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypeVar
from urllib.parse import urlencode, urlparse

from chkit.clickhouse.replicas import (
    all_replicas,
    resolve_replica_fanout_or_raise,
    string_literal,
)

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


# The ClickHouse in test/infra/docker-compose.yml, which `bun run infra:up`
# starts on CHKIT_TEST_PORT (default 8123).
_LOCAL_STACK_PORT = (os.environ.get("CHKIT_TEST_PORT") or "").strip() or "8123"
LOCAL_STACK_ENV = LiveEnv(
    clickhouse_url=f"http://localhost:{_LOCAL_STACK_PORT}",
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
    port = parsed.port if parsed.port is not None else (443 if secure else 80)
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


def drop_database(
    client: Any, database: str, *, timeout: float = 30.0, interval: float = 0.5
) -> None:
    """Drop a test database, re-running the DROP while it fails with ``DATABASE_NOT_EMPTY``.

    DROP DATABASE drops the tables the serving replica lists, then fails if a
    table appeared meanwhile. On a multi-replica service (ObsessionDB) that
    happens when the replica applies an earlier CREATE during the drop; the
    server answers "Try again". Any other error raises at once. ``timeout``
    stops the re-runs; it does not cut short a DROP that is still running.
    Port of TS ``dropDatabase``.
    """
    deadline = time.monotonic() + timeout
    while True:
        try:
            client.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
            return
        except Exception as error:
            if time.monotonic() >= deadline or "DATABASE_NOT_EMPTY" not in str(error):
                raise
        time.sleep(interval)


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
    """Return ``_chkit_migrations_<label>_<runTag>_<rand>``.

    Mirrors TS ``createJournalTableName``: prefers ``GITHUB_RUN_ID`` (so CI
    reruns can be correlated) and falls back to ``<ms>``. The random suffix is
    always added: the TS and Python suites run at the same time against one
    server and share labels, so the run id alone collides. Used to point
    ``CHKIT_JOURNAL_TABLE`` at a per-test journal so parallel tests don't
    contend on the shared ``_chkit_migrations`` table.
    """
    run_tag = (os.environ.get("GITHUB_RUN_ID") or "").strip() or str(int(time.time() * 1000))
    return f"_chkit_migrations_{label}_{run_tag}_{_random_suffix()}"


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
_NOT_YET_VISIBLE_ERRORS = ("UNKNOWN_TABLE", "UNKNOWN_DATABASE")


def run_once_visible(run: Callable[[], T], *, timeout: float = 30.0, interval: float = 0.5) -> T:
    """Run a statement that needs an object an earlier DDL created.

    On a multi-replica service (ObsessionDB) each request may land on a
    different replica, and one that hasn't applied the CREATE yet answers
    ``UNKNOWN_TABLE`` (or ``UNKNOWN_DATABASE``) even after ``wait_for_table``
    saw the table on another one. Such a failure changes nothing, so the statement is re-run until the
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
    client: Any,
    database: str,
    table: str,
    *,
    timeout: float = 30.0,
    cluster: str | None = None,
) -> None:
    """Poll until every replica of the service lists ``database.table``.

    ``wait_for_table`` sees one replica per attempt, so on a multi-replica
    service (ObsessionDB) the next request can still land on one that has not
    applied the CREATE. Discover the service replicas (``cluster``, default
    ``default``) as the production propagation waits do, then count replicas
    listing the table through ``clusterAllReplicas`` until all of them do;
    otherwise (a single node) ``system.tables`` is enough.
    ``client.query(sql)`` must return an object with ``rows``.
    """
    _wait_for_table_listing(
        client, database, table, want="present", timeout=timeout, cluster=cluster
    )


def wait_for_table_absent_on_every_replica(
    client: Any,
    database: str,
    table: str,
    *,
    timeout: float = 30.0,
    cluster: str | None = None,
) -> None:
    """Poll until no replica lists ``database.table``: a CREATE of the same
    name can land on a replica that has not applied the DROP yet. TS uses the
    production ``waitForTableAbsent`` with a ``deadlineMs``."""
    _wait_for_table_listing(
        client, database, table, want="absent", timeout=timeout, cluster=cluster
    )


def _wait_for_table_listing(
    client: Any,
    database: str,
    table: str,
    *,
    want: Literal["present", "absent"],
    timeout: float,
    cluster: str | None,
) -> None:
    fanout = resolve_replica_fanout_or_raise(client, cluster)
    fanout_cluster = fanout.cluster if fanout else ""
    db = database.replace("\\", "\\\\").replace("'", "\\'")
    name = table.replace("\\", "\\\\").replace("'", "\\'")
    if fanout_cluster:
        quoted_cluster = fanout_cluster.replace("\\", "\\\\").replace("'", "\\'")
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

    def done(value: Any) -> bool:
        listed = int(value["listed"])
        return listed >= int(value["replicas"]) if want == "present" else listed == 0

    row = poll_until(lambda: client.query(sql).rows[0], done, timeout=timeout)
    if not done(row):
        msg = (
            f"{database}.{table} is listed on {row['listed']} of "
            f"{row['replicas']} replicas after {timeout}s"
        )
        raise AssertionError(msg)


def run_on_every_replica(
    client: Any,
    env: LiveEnv,
    statement: str,
    *,
    timeout: float = 60.0,
    interval: float = 0.5,
) -> None:
    """Run a replica-local statement, such as ``SYSTEM STOP MERGES db.t``, on
    every replica of the target, and return once each replica's
    ``system.query_log`` shows it finished there.

    On a multi-replica service (ObsessionDB) a SYSTEM statement acts only on
    the replica that serves it, and ON CLUSTER is refused. The load balancer
    spreads requests over the replicas (round-robin on the test service), so
    each round sends the statement, tagged with a ``log_comment``, once per
    replica in a row, then flushes the query log once per replica, until every
    replica ``clusterAllReplicas`` reaches has logged it. A round with any
    other request between two of its own could keep reaching the same
    replica, so rounds are a random time apart, which moves them against
    concurrent callers. The statement must be safe to repeat, and its table
    must already be on every replica: ``SYSTEM STOP MERGES`` on a missing
    table succeeds and does nothing. On a single node it runs once, through
    ``client``. TS twin: ``runOnEveryReplica``.
    """
    fanout = resolve_replica_fanout_or_raise(client)
    if fanout is None:
        client.execute(statement)
        return
    tag = f"chkit_e2e_every_replica_{create_run_tag()}"
    coverage = (
        f"SELECT (SELECT count(DISTINCT hostName()) FROM {all_replicas(fanout, 'system.one')})"
        f" AS replicas, (SELECT count(DISTINCT hostName()) FROM "
        f"{all_replicas(fanout, 'system.query_log')} WHERE event_date >= yesterday() AND "
        f"type = 'QueryFinish' AND log_comment = {string_literal(tag)}) AS ran "
        "SETTINGS skip_unavailable_shards = 0"
    )
    deadline = time.monotonic() + timeout
    while True:
        for _ in range(fanout.replicas):
            _send_on_new_connection(env, statement, {"log_comment": tag})
        # A replica writes its query_log every few seconds; a flush writes it now.
        for _ in range(fanout.replicas):
            _send_on_new_connection(env, "SYSTEM FLUSH LOGS")
        row = client.query(coverage).rows[0]
        replicas = int(row["replicas"])
        ran = int(row["ran"])
        if replicas > 0 and ran >= replicas:
            return
        if time.monotonic() >= deadline:
            msg = (
                f"run_on_every_replica: {statement} ran on {ran} of {replicas} "
                f"replicas after {timeout}s"
            )
            raise AssertionError(msg)
        time.sleep(interval * (0.5 + random.random()))


def _send_on_new_connection(env: LiveEnv, sql: str, settings: dict[str, str] | None = None) -> None:
    """One HTTP request on a connection of its own, so no connection affinity
    keeps it on the replica that served the previous one."""
    credentials = base64.b64encode(
        f"{env.clickhouse_user}:{env.clickhouse_password}".encode()
    ).decode()
    request = urllib.request.Request(
        f"{env.clickhouse_url.rstrip('/')}/?{urlencode(settings or {})}",
        data=sql.encode(),
        headers={"Authorization": f"Basic {credentials}", "Connection": "close"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            response.read()
    except urllib.error.HTTPError as error:
        msg = f"{sql}: HTTP {error.code}: {error.read().decode(errors='replace')}"
        raise RuntimeError(msg) from error


class _CliResultLike(Protocol):
    """Structural type covering ``typer.testing.Result`` and ad-hoc CLI results.

    Anything with ``exit_code`` + ``output`` fits — that's what the diagnostic
    formatter needs. Defined as a Protocol so callers don't have to import
    typer just to satisfy a type hint.
    """

    @property
    def exit_code(self) -> int: ...

    @property
    def output(self) -> str: ...


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
    "run_on_every_replica",
    "run_once_visible",
    "wait_for_table_absent_on_every_replica",
    "wait_for_table_on_every_replica",
]



def held_lock_claim(client: Any, database: str, journal_table: str) -> str:
    """The migrate lock claim that a killed run left behind in the journal
    (#716), for ``--break-lock``. Port of the TS ``heldLockClaim``."""
    prefix = "__chkit_migrate_lock__/"
    rows = client.query(
        f"SELECT substring(name, {len(prefix) + 1}) AS claim "
        f"FROM {quote_ident(database)}.{quote_ident(journal_table)} "
        f"WHERE startsWith(name, '{prefix}') GROUP BY name "
        "HAVING max(applied_at) < toDateTime64('2299-01-01 00:00:00', 3, 'UTC') "
        "SETTINGS select_sequential_consistency = 1"
    ).rows
    assert len(rows) == 1, f"expected one held migrate lock claim, found {rows}"
    return str(rows[0]["claim"])
