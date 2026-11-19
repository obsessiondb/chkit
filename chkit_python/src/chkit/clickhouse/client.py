"""Thin, strictly-typed wrapper over ``clickhouse-connect``.

We intentionally expose a minimal surface — only what the CLI needs (execute
DDL, fetch rows of dictionaries, introspect databases/tables). The third-party
client returns ``Any`` extensively; this wrapper narrows it down.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import socket
import threading
import time
import uuid
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Literal, NoReturn, Protocol, Self, TypeVar
from urllib.parse import unquote, urlparse

import clickhouse_connect  # type: ignore[import-untyped]
import httpx
from clickhouse_connect.driver import httputil  # type: ignore[import-untyped]
from clickhouse_connect.driver.exceptions import (  # type: ignore[import-untyped]
    DatabaseError,
)
from pydantic import BaseModel, ConfigDict
from urllib3 import HTTPConnectionPool, HTTPSConnectionPool, Timeout
from urllib3.connection import HTTPConnection, HTTPSConnection
from urllib3.exceptions import (
    ConnectTimeoutError,
    HTTPError,
    NameResolutionError,
    NewConnectionError,
)

from chkit.clickhouse.control import (
    STRICT_CONTROL_SETTINGS,
    remaining_control_seconds,
    run_control_request,
)
from chkit.clickhouse.replicas import all_replicas, resolve_replica_fanout
from chkit.core.jsnum import js_math_round
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit.core.sql_lexer import js_trim

# chkit prints its own one-line error, as TS silences @clickhouse/client's
# logger: without a handler, the driver's warnings (``Unexpected Http Driver
# Exception``) would reach stderr through logging's last-resort handler.
logging.getLogger("clickhouse_connect").addHandler(logging.NullHandler())

QueryStatusKind = Literal["running", "finished", "failed", "unknown"]

# TS's PROGRESS_SETTINGS (``@chkit/clickhouse``): a progress header every 30 s.
PROGRESS_INTERVAL_MS = "30000"

# Column types whose JSON numbers a float cannot hold exactly: 64-bit and wider
# integers and Decimals. The TS port (``@chkit/clickhouse``, ``exact-json.ts``)
# uses the same patterns.
_EXACT_TYPE_RE = re.compile(r"\b(?:U?Int(?:64|128|256)|Decimal(?:32|64|128|256)?)\b")
# Column types whose values can hold any number, from a Float64 to a UInt64
# (#438). A number in them becomes a string only when a float would change it.
_DYNAMIC_TYPE_RE = re.compile(r"\b(?:JSON|Object|Dynamic)\b")
# Up to 15 significant digits always survive a float (DBL_DIG).
_DBL_DIG = 15
_DECIMAL_RE = re.compile(r"(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?")

# How a column's numbers are read: as numbers, as the digits ClickHouse wrote,
# or as digits only when a float would change them.
_NumberMode = Literal["number", "digits", "round_trip"]


class QueryResult(BaseModel):
    """Container for a SELECT result."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    column_names: list[str]
    rows: list[dict[str, Any]]


class ClickHouseColumnMeta(BaseModel):
    """One column entry in `ClickHouseJsonQueryResult.meta`."""

    model_config = ConfigDict(frozen=True)

    name: str
    type: str


class ClickHouseJsonQueryResult(BaseModel):
    """Envelope returned by `query_json`.

    Mirrors `@chkit/clickhouse`'s ``ClickHouseJsonQueryResult`` shape so
    ``chkit query --json`` output is stable across the TS and Python ports.
    Other keys of the server envelope (``rows_before_limit_at_least``) are kept.
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    data: list[dict[str, Any]]
    meta: list[ClickHouseColumnMeta]
    rows: int
    statistics: dict[str, Any] | None = None
    query_id: str | None = None


class QueryStatus(BaseModel):
    """Result of `query_status`. Mirrors `QueryStatus` from `@chkit/clickhouse`."""

    model_config = ConfigDict(frozen=True)

    status: QueryStatusKind
    read_rows: int | None = None
    read_bytes: int | None = None
    written_rows: int | None = None
    written_bytes: int | None = None
    elapsed_ms: int | None = None
    duration_ms: int | None = None
    error: str | None = None
    # A failure the server logged before the query started (ExceptionBeforeStart).
    before_start: bool = False


class ClickHouseClient:
    """Imperative client wrapper. Use as a context manager."""

    #: ``submit_once`` asks ``SEND_ADMISSION`` at its transport (#765): an
    #: executor needs this marker for an interruptible backfill.
    transport_admission = True

    __slots__ = (
        "_client",
        "_closed",
        "_config",
        "_send_once_client",
        "_send_once_inflight",
        "_send_once_pool",
        "_submit_client",
        "_submit_client_lock",
    )

    def __init__(self, client: Any, config: ChxResolvedClickHouseConfig) -> None:
        self._client: Any = client
        self._config: ChxResolvedClickHouseConfig = config
        # The driver `submit` sends through, opened on first use.
        self._submit_client: Any = None
        self._submit_client_lock = threading.Lock()
        # The driver submit_once sends through, with a pool of its own.
        self._send_once_client: Any = None
        self._send_once_pool: Any = None
        # submit_once calls in progress, by pool: the last one to end after
        # close() unregisters that pool again (see submit_once).
        self._send_once_inflight: dict[int, int] = {}
        self._closed = False

    @classmethod
    def connect(cls, config: ChxResolvedClickHouseConfig) -> Self:
        """Connect using a resolved config block."""
        return cls(cls._open_driver(config), config)

    @staticmethod
    def _open_driver(config: ChxResolvedClickHouseConfig, **options: Any) -> Any:
        """Open a ``clickhouse-connect`` client; ``options`` go to ``get_client``."""
        parsed = urlparse(config.url)
        # Like the TS client (``@clickhouse/client``): the URL scheme sets the
        # protocol, a URL without a port uses the scheme's default port, and
        # credentials in the URL take precedence over the configured ones. The
        # scheme is checked first, so a URL without one (``user:pw@host``)
        # names only what it read as the scheme.
        if parsed.scheme not in ("http", "https"):
            msg = f"ClickHouse URL protocol must be either http or https. Got: {parsed.scheme}:"
            raise ValueError(msg)
        host = parsed.hostname
        if host is None:
            msg = f"Invalid ClickHouse URL (missing host): {_url_without_credentials(config.url)}"
            raise ValueError(msg)
        secure = parsed.scheme == "https"
        port = parsed.port
        if port is None:
            port = 443 if secure else 80
        username = unquote(parsed.username) if parsed.username else config.username
        password = unquote(parsed.password) if parsed.password else config.password

        # Connect without the database: clickhouse-connect's connect-time
        # probes would send it, and ClickHouse rejects every request for a
        # database that does not exist yet (UNKNOWN_DATABASE). Setting it
        # afterwards sends it with each request instead, as the TS client does,
        # so commands report a missing database and ``migrate --apply`` can
        # create it (#351).
        try:
            client = clickhouse_connect.get_client(
                host=host,
                port=port,
                username=username,
                password=password,
                secure=secure,
                connect_timeout=None,
                **options,
            )
        except Exception as error:
            wrap_connection_error(error, config.url, config.username)
        client.database = config.database
        _use_ts_timeouts(client)
        return client

    def open_concurrent(self) -> ClickHouseClient:
        """A new client to the same target without an HTTP session, for requests
        sent while one of this client's requests is in flight (ClickHouse runs
        one query at a time per session). The caller closes it. TS
        ``openConcurrent``."""
        return ClickHouseClient(
            self._open_driver(self._config, autogenerate_session_id=False), self._config
        )

    def close(self) -> None:
        # Does not wait for a submit driver still opening (on the thread of an
        # interrupted async migrate), which has no connect timeout: that
        # thread sees ``_closed``, closes its driver and sends nothing.
        self._closed = True
        self._client.close()
        with self._submit_client_lock:
            submit_client, self._submit_client = self._submit_client, None
            send_once_client, self._send_once_client = self._send_once_client, None
            send_once_pool, self._send_once_pool = self._send_once_pool, None
        if submit_client is not None:
            submit_client.close()
        if send_once_client is not None:
            send_once_client.close()
        if send_once_pool is not None:
            _dispose_pool(send_once_pool)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    @property
    def database(self) -> str:
        return self._config.database

    @property
    def query_control_cluster(self) -> str | None:
        return self._config.cluster

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
        """Run a statement (DDL or DML) without returning rows.

        ``settings`` are per-statement ClickHouse settings (mirrors the TS
        executor's ``command(sql, settings)``). As in TS, a statement that
        fails because the configured database does not exist is retried without
        it, which lets the ``CREATE DATABASE`` of a first migration run."""
        self.execute_guarded(statement, lambda: None, settings)

    def _write_settings(self) -> dict[str, Any]:
        """No asynchronous INSERT, as TS sends with every write, so a write is
        stored when it returns. A user that cannot change the setting
        (readonly = 1) cannot write either, so it is left out there, where
        clickhouse-connect would refuse it before the server's own error."""
        setting = self._client.server_settings.get("async_insert")
        return {"async_insert": 0} if setting is not None and not setting.readonly else {}

    def execute_guarded(
        self, statement: str, check: Callable[[], None], settings: dict[str, Any] | None = None
    ) -> None:
        """Check ownership before each command attempt, including an internal retry."""
        settings = {**self._write_settings(), **(settings or {})}
        check()
        try:
            self._client.command(statement, settings=settings)
        except DatabaseError as error:
            if not is_unknown_database_error(error):
                raise
            check()
            self._client.command(statement, settings=settings, use_database=False)

    def execute_tracked(
        self,
        statement: str,
        check: Callable[[], None],
        before_attempt: Callable[[], str],
        settings: dict[str, Any] | None = None,
    ) -> None:
        """Persist an id before each physical send; never replay an ambiguous send."""
        check()
        query_id = before_attempt()
        check()
        try:
            self._tracked_attempt(statement, query_id, settings, use_database=True)
        except DatabaseError as error:
            if not is_unknown_database_error(error):
                raise
            check()
            query_id = before_attempt()
            check()
            self._tracked_attempt(statement, query_id, settings, use_database=False)

    def _tracked_attempt(
        self, statement: str, query_id: str, settings: dict[str, Any] | None, *, use_database: bool
    ) -> None:
        # clickhouse-connect 0.15.1 retries a remotely closed connection once,
        # even with query_retries=0. The same id must never name that replay.
        pool = self._client.http
        self._client.http = _SingleAttemptPool(pool)
        try:
            self._client.command(
                statement,
                settings={
                    "wait_end_of_query": 1, "async_insert": 0,
                    **(settings or {}), "query_id": query_id,
                },
                use_database=use_database,
            )
        finally:
            self._client.http = pool

    def query_control(
        self, statement: str, timeout_ms: float, *, query_id: str | None = None,
        settings: dict[str, Any] | None = None,
    ) -> QueryResult:
        """A session-free, non-retrying control request with one absolute budget."""
        def request(deadline: float) -> QueryResult:
            parsed = urlparse(self._config.url)
            url = httpx.URL(scheme=parsed.scheme, host=parsed.hostname or "", port=parsed.port)
            username = unquote(parsed.username) if parsed.username else self._config.username
            password = unquote(parsed.password) if parsed.password else self._config.password
            with httpx.Client(transport=httpx.HTTPTransport(retries=0)) as control:
                response = control.post(
                    url,
                    auth=(username, password),
                    params={
                        "database": self._config.database, "default_format": "JSONEachRow",
                        **{key: str(value) for key, value in (settings or {}).items()
                           if key != "query_id" and value is not None},
                        **STRICT_CONTROL_SETTINGS,
                        "wait_end_of_query": "1",
                        **({"query_id": query_id} if query_id else {}),
                    },
                    headers={"Connection": "close"},
                    content=statement,
                    timeout=remaining_control_seconds(deadline),
                )
                if response.is_error or response.headers.get("X-ClickHouse-Exception-Code") not in (
                    None, "", "0",
                ):
                    raise DatabaseError(response.text)
                rows = [json.loads(line) for line in response.text.splitlines() if line.strip()]
                return QueryResult(column_names=list(rows[0]) if rows else [], rows=rows)

        return run_control_request(request, timeout_ms)

    def query(
        self,
        statement: str,
        settings: dict[str, Any] | None = None,
    ) -> QueryResult:
        """Run a SELECT and return rows as a list of dicts.

        ``settings`` are per-query ClickHouse settings (mirrors the TS
        executor's ``query(sql, settings)``); ``None``-valued entries are
        dropped, matching ``JSON.stringify`` omitting ``undefined``.
        """
        effective_settings = (
            {key: value for key, value in settings.items() if value is not None}
            if settings is not None
            else None
        )
        result = self._client.query(statement, settings=effective_settings)
        column_names: list[str] = list(result.column_names)
        rows: list[dict[str, Any]] = [
            dict(zip(column_names, row, strict=True)) for row in result.result_rows
        ]
        return QueryResult(column_names=column_names, rows=rows)

    def query_json(self, statement: str) -> ClickHouseJsonQueryResult:
        """Run a SELECT and return ClickHouse's ``JSON`` format envelope.

        As in TS, the server's own ``FORMAT JSON`` output is returned as is
        (type names in ``meta``, values and ``statistics`` as ClickHouse
        formats them, read by `parse_json_result`), plus the ``query_id``.
        Trailing semicolons are dropped before ``FORMAT JSON`` is appended, as
        ``@clickhouse/client`` does.
        """
        query_id = str(uuid.uuid4())
        body = self._client.raw_query(
            js_trim(statement).rstrip(";"), settings={"query_id": query_id}, fmt="JSON"
        )
        return ClickHouseJsonQueryResult.model_validate(
            {**parse_json_result(body), "query_id": query_id}
        )

    def submit(
        self,
        statement: str,
        query_id: str | None = None,
        settings: dict[str, Any] | None = None,
        *,
        before_send: Callable[[], None] | None = None,
    ) -> str:
        """Send a query that ``query_status`` follows. Returns its query_id.

        ``before_send`` is the caller's guard (#767): called before the
        request starts and, through ``commit``, once its connection is open and
        before its first bytes are written. Either raises to stop a request
        the caller gave up on.

        Used by ``chkit migrate --apply`` for long-running ``ALTER`` /
        ``OPTIMIZE`` statements: the server starts processing immediately
        and the CLI polls ``query_status`` until terminal. ``settings`` are
        sent with the query (TS ``submit(sql, queryId, settings)``).

        Like TS, this returns when the request does, at the end of the query;
        a caller that polls meanwhile runs it on another thread. The request
        goes through a driver without a session, as TS's fire-and-forget
        client does: ClickHouse runs one query at a time per session, so in
        the session ``query_status`` uses, the polls would be locked out
        (``Session ... is locked by a concurrent client``) until the query
        ends, even after a proxy cut the request (HTTP 524).
        """
        qid = query_id or str(uuid.uuid4())
        # clickhouse-connect's command() has no query_id parameter; over HTTP
        # the id travels as a query parameter, which the driver forwards from
        # per-query settings. Verified live: the id lands in system.query_log.
        driver = self._submit_driver()
        _SUBMIT_SEND.before_send = before_send
        try:
            driver.command(statement, settings={**(settings or {}), "query_id": qid})
        finally:
            _SUBMIT_SEND.before_send = None
        return qid

    def submit_once(
        self,
        statement: str,
        query_id: str,
        settings: dict[str, Any] | None = None,
    ) -> str:
        """``submit`` with one physical send: clickhouse-connect 0.15.1 resends a
        request whose connection the remote closed, even with
        ``query_retries=0``, and the same id must never name a second send of
        a write (a backfill chunk could run twice). A connection failure
        raises instead. TS's client sends a request once.

        It sends through a driver with a urllib3 pool of its own, whose
        ``urlopen`` asks the ``SEND_ADMISSION`` of this request only (a
        context variable: an unrelated request, or another thread's, never
        answers for it). When the admission refuses, nothing is sent and
        ``SendNotAdmittedError`` is raised. ``prepare_submit_once`` opens
        that driver ahead of the send."""
        driver = self.prepare_submit_once()
        pool = driver.http
        with self._submit_client_lock:
            self._send_once_inflight[id(pool)] = self._send_once_inflight.get(id(pool), 0) + 1
        send = _Send(SEND_ADMISSION.get())
        token = _CURRENT_SEND.set(send)
        try:
            driver.command(statement, settings={**(settings or {}), "query_id": query_id})
        except SendNotAdmittedError:
            raise
        except Exception as error:
            if send.sent and not send.handed_off and _timed_out(error):
                raise SendConnectTimeoutError(_connect_timeout_message()) from error
            raise
        finally:
            _CURRENT_SEND.reset(token)
            with self._submit_client_lock:
                left = self._send_once_inflight[id(pool)] - 1
                if left:
                    self._send_once_inflight[id(pool)] = left
                else:
                    del self._send_once_inflight[id(pool)]
                # The driver's connection-expiry check can register the pool
                # again after close() dropped it; the last call out drops it.
                if not left and self._closed:
                    httputil.all_managers.pop(pool, None)
        return query_id

    def prepare_submit_once(self) -> Any:
        """Open the driver ``submit_once`` sends through, if it is not open
        yet: connection setup, which may stall, done before a caller admits
        a send."""
        with self._submit_client_lock:
            client = self._send_once_client
        if client is None and not self._closed:
            pool = _own_pool_manager(self._config.url)
            # Opened outside the lock, so close() does not wait for it.
            try:
                opened = self._open_driver(
                    self._config, autogenerate_session_id=False, pool_mgr=pool
                )
            except BaseException:
                _dispose_pool(pool)
                raise
            # Bounded until the request is written (connect, TLS handshake and
            # the write itself); the wait for the INSERT's response is not.
            opened.timeout = Timeout(connect=SEND_CONNECT_TIMEOUT_MS / 1000, read=None)
            with self._submit_client_lock:
                if self._send_once_client is None and not self._closed:
                    self._send_once_client = opened
                    self._send_once_pool = pool
                client = self._send_once_client
            if client is not opened:
                opened.close()
                _dispose_pool(pool)
        if self._closed or client is None:
            msg = "ClickHouse client is closed."
            raise RuntimeError(msg)
        return client

    def _submit_driver(self) -> Any:
        with self._submit_client_lock:
            submit_client = self._submit_client
        if submit_client is None and not self._closed:
            # Opened outside the lock, so close() does not wait for it.
            opened = self._open_driver(self._config, autogenerate_session_id=False)
            # One physical send per submit: the id is journaled for this
            # attempt alone, so the driver must not send it again (#767). A
            # submit the caller gave up on is not sent once it has connected,
            # and connecting is bounded, so the caller can tell a late send
            # is excluded.
            opened.timeout = Timeout(connect=SUBMIT_CONNECT_TIMEOUT_SECONDS, read=None)
            opened.http.pool_classes_by_scheme = {
                "http": _GuardedHTTPConnectionPool,
                "https": _GuardedHTTPSConnectionPool,
            }
            opened.http.clear()
            opened.http = _NoReplayPool(opened.http)
            with self._submit_client_lock:
                if self._submit_client is None and not self._closed:
                    self._submit_client = opened
                submit_client = self._submit_client
            if submit_client is not opened:
                opened.close()
        # close() may have run while the driver opened.
        if self._closed or submit_client is None:
            msg = "ClickHouse client is closed."
            raise RuntimeError(msg)
        return submit_client

    def insert(
        self,
        table: str,
        values: list[list[Any]] | list[dict[str, Any]],
        *,
        column_names: list[str] | None = None,
        database: str | None = None,
    ) -> None:
        """Insert rows into a table.

        Thin pass-through to ``clickhouse-connect``'s ``client.insert``.
        ``values`` may be a list of dicts (then ``column_names`` is inferred
        from the keys of the first row) or a list of lists (then
        ``column_names`` is required).
        """
        if not values:
            return
        cols = column_names
        rows: list[list[Any]] | list[dict[str, Any]] = values
        if cols is None and isinstance(values[0], dict):
            cols = list(values[0].keys())
            rows = [[row.get(col) for col in cols] for row in values]
        elif cols is None:
            msg = "insert() requires column_names when values is a list of lists."
            raise ValueError(msg)
        # No asynchronous INSERT, as TS's insert sends (#767).
        self._client.insert(
            table, rows, column_names=cols, database=database, settings=self._write_settings()
        )


    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
        include_before_start: bool = False,
    ) -> QueryStatus:
        """Check whether a previously-submitted query is running / finished / failed.

        ``include_before_start`` counts an ExceptionBeforeStart entry (a
        statement the server rejected) as the query's failure, for an id that
        names one attempt alone (#767): a reused id can find an earlier
        attempt's entry.

        Polls ``system.processes`` first (running?), then falls back to
        ``system.query_log`` for the terminal state. The query runs on the
        replica that received it, so on a multi-replica target (#246) both are
        read on every replica of ``clickhouse.cluster`` (or ``default``)
        through ``clusterAllReplicas``. A replica that cannot be read is
        skipped, so a poll keeps going while one is down; ``every_replica``
        fails the read instead, so a status other than ``running`` means that
        no replica runs the query. ``running_only`` reads only
        ``system.processes``, so the status is ``running`` or ``unknown``: a
        server creates ``system.query_log`` on its first log flush, so a fresh
        one has none yet.
        """
        fanout = resolve_replica_fanout(self, self._config.cluster)

        def source(table: str) -> str:
            return all_replicas(fanout, table) if fanout else table

        read_settings = {"skip_unavailable_shards": 0 if every_replica else 1}
        running_sql = (
            "SELECT read_rows, read_bytes, written_rows, written_bytes, elapsed "
            f"FROM {source('system.processes')} "
            f"WHERE user = currentUser() AND query_id = '{query_id}'"
        )
        running = self.query(running_sql, settings=read_settings)
        if running.rows:
            row = running.rows[0]
            return QueryStatus(
                status="running",
                read_rows=_safe_int(row.get("read_rows")),
                read_bytes=_safe_int(row.get("read_bytes")),
                written_rows=_safe_int(row.get("written_rows")),
                written_bytes=_safe_int(row.get("written_bytes")),
                elapsed_ms=_safe_round_ms(row.get("elapsed")),
            )
        if running_only:
            return QueryStatus(status="unknown")

        after = after_time or "1970-01-01 00:00:00"
        # event_date prunes query_log's partitions: the entry is logged no earlier
        # than the query started. A day of slack covers a session time zone other
        # than the server's; toDate32, as a Date before 1970 wraps around.
        types = (
            "'QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart'"
            if include_before_start
            else "'QueryFinish', 'ExceptionWhileProcessing'"
        )
        # With ExceptionBeforeStart, every entry of the id is read: a rejected
        # duplicate delivery logs one early, which must not hide the
        # QueryFinish of the attempt that ran (#767).
        log_sql = (
            "SELECT type, written_rows, written_bytes, query_duration_ms, exception, "
            "exception_code, toString(serverUUID()) AS server, "
            "toString(event_time_microseconds) AS event_at "
            f"FROM {source('system.query_log')} "
            f"WHERE user = currentUser() AND query_id = '{query_id}' "
            f"AND type IN ({types}) "
            "AND is_initial_query = 1 "
            f"AND query_start_time >= parseDateTimeBestEffort('{after}') "
            f"AND event_date >= toDate32(parseDateTimeBestEffort('{after}')) - 1 "
            "ORDER BY event_time DESC"
            f"{'' if include_before_start else ' LIMIT 1'}"
        )
        log = self.query(log_sql, settings=read_settings)
        return query_log_outcome(log.rows)

    def list_databases(self) -> list[str]:
        result = self.query("SHOW DATABASES")
        return [str(row["name"]) for row in result.rows]

    def list_tables(self, database: str) -> list[str]:
        # Parameterized via format string is OK here: only safe identifiers.
        result = self.query(f"SHOW TABLES FROM {database}")
        return [str(row["name"]) for row in result.rows]

    def list_schema_objects(self) -> Any:
        """Mirror of TS ``ClickHouseExecutor.listSchemaObjects``.

        Delegates to the module-level helper so the standalone function and
        method form return the exact same shape. Useful when callers hold a
        ``ClickHouseClient`` (or compatible duck) and don't want to import the
        introspect module directly.
        """
        # Imported lazily inside the method to avoid the
        # ``introspect → client → introspect`` import cycle that would happen
        # if we hoisted it to module-level (``introspect.py`` doesn't import
        # ``client.py`` today, but reversing the dependency direction would
        # rule it out forever).
        from chkit.clickhouse.introspect import (  # noqa: PLC0415
            list_schema_objects,
        )

        return list_schema_objects(self)

    def list_table_details(self, databases: list[str]) -> Any:
        """Mirror of TS ``ClickHouseExecutor.listTableDetails``."""
        from chkit.clickhouse.introspect import (  # noqa: PLC0415
            list_table_details,
        )

        return list_table_details(self, databases)


class SendAdmission(Protocol):
    """Asked by ``submit_once`` right before its request enters the transport
    (#765). ``admit`` returning False sends nothing. ``handed_off`` is called
    once urllib3 has written the whole request (request line, headers and
    body) to the socket; a caller also ends its own wait when ``submit_once``
    returns or raises without getting there. A caller that stops can
    therefore wait until every admitted send has handed off, and know that no
    request of it starts afterwards. An admission may also have
    ``attach(abandon)``, called once ``admit`` returned True, with the
    request's ``abandon``: calling it destroys the request's socket and
    refuses any later write, so no more of the request is sent (TS's
    ``abandon``)."""

    def admit(self) -> bool: ...

    def handed_off(self) -> None: ...


#: How long an admitted request may take to connect (TCP and TLS) and write
#: itself to its socket (TS ``SEND_CONNECT_TIMEOUT_MS``). Past it, the send
#: fails: a connection that never completes (a stalled load balancer or TLS
#: terminator) must not hold a backfill's interrupt (#765). The wait for the
#: INSERT's response has no limit.
SEND_CONNECT_TIMEOUT_MS = 10_000


class SendConnectTimeoutError(RuntimeError):
    """``submit_once``'s request did not connect and get written in time."""


class SendAbandonedError(RuntimeError):
    """``submit_once``'s request was abandoned before it was written."""


def _connect_timeout_message() -> str:
    return (
        f"The request could not connect and be written within {SEND_CONNECT_TIMEOUT_MS} ms "
        "(name lookup, TCP connect, TLS handshake and the request itself), so it was destroyed. "
        "It may have reached the server."
    )


def _timed_out(error: BaseException) -> bool:
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, TimeoutError) or type(current).__name__.endswith("TimeoutError"):
            return True
        if any(isinstance(arg, BaseException) and _timed_out(arg) for arg in current.args):
            return True
        current = current.__cause__ or current.__context__
    return False


#: Set by a caller that must not send once it stops (#765), asked after any
#: lazy connection setup.
SEND_ADMISSION: ContextVar[SendAdmission | None] = ContextVar(
    "chkit_send_admission", default=None
)


class SendNotAdmittedError(RuntimeError):
    """``submit_once`` did not send: ``SEND_ADMISSION`` refused it."""


@dataclass
class _Send:
    """One ``submit_once`` request: its admission, whether it was sent and
    handed off, and what ``abandon`` needs: the connection it writes to."""

    admission: SendAdmission | None
    sent: bool = False
    handed_off: bool = False
    abandoned: bool = False
    conn: Any = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def writing(self, conn: Any) -> None:
        """Called by the connection right before it writes the request: from
        then on, ``abandon`` shuts its socket down."""
        with self.lock:
            if self.abandoned:
                raise SendAbandonedError(_ABANDONED_MESSAGE)
            self.conn = conn

    def abandon(self) -> None:
        """No more of the request is written: a later write is refused, and a
        write in progress fails on its shut-down socket."""
        with self.lock:
            self.abandoned = True
            conn = self.conn
        sock = getattr(conn, "sock", None)
        if sock is not None:
            # socket.socket's own shutdown: SSLSocket's would also drop its
            # TLS state under the writing thread.
            with contextlib.suppress(OSError):
                socket.socket.shutdown(sock, socket.SHUT_RDWR)


_ABANDONED_MESSAGE = (
    "The request was abandoned before it was written: its caller stopped waiting for it. "
    "It may have reached the server."
)


_CURRENT_SEND: ContextVar[_Send | None] = ContextVar("chkit_current_send", default=None)


def _own_pool_manager(url: str) -> Any:
    """A urllib3 pool for ``submit_once`` alone, routed as clickhouse-connect
    routes a driver without a pool of its own: an HTTPS URL takes
    ``HTTPS_PROXY``, then (like any URL) ``HTTP_PROXY``, each unless
    ``NO_PROXY`` names the host; otherwise a direct pool. Its ``urlopen``
    carries a stable hook that resolves the current request's own ``_Send``.
    It is never shared, and ``_dispose_pool`` clears and unregisters it."""
    parsed = urlparse(url)
    scheme = parsed.scheme
    host = parsed.hostname or ""
    port = parsed.port or (443 if scheme == "https" else 80)
    https_proxy = httputil.check_env_proxy("https", host, port) if scheme == "https" else None
    http_proxy = None if https_proxy else httputil.check_env_proxy("http", host, port)
    if https_proxy:
        pool = httputil.get_pool_manager(https_proxy=https_proxy)
    elif http_proxy:
        pool = httputil.get_pool_manager(http_proxy=http_proxy)
    else:
        pool = httputil.get_pool_manager()
    install_send_hook(pool)
    return pool


def _dispose_pool(pool: Any) -> None:
    """Close a ``submit_once`` pool and drop it from clickhouse-connect's
    process-wide registry of managers, which would keep it alive."""
    pool.clear()
    httputil.all_managers.pop(pool, None)


def _body_after_handoff(kwargs: dict[str, Any], send: _Send) -> dict[str, Any]:
    """``urlopen``'s arguments with the body as an iterable that reports the
    handoff once urllib3 has written it (it asks for the next part only after
    writing the last), as TS reports it on the request's ``finish``. The
    body's Content-Length is set explicitly, so urllib3 sends it as is, not
    chunked: some proxies reject chunked POSTs."""
    body = kwargs.get("body")
    data = body.encode() if isinstance(body, str) else (body or b"")
    admission = send.admission

    def chunks() -> Any:
        if data:
            yield data
        send.handed_off = True
        if admission is not None:
            admission.handed_off()

    headers = {
        **{key: value for key, value in (kwargs.get("headers") or {}).items()
           if key.lower() not in {"content-length", "transfer-encoding"}},
        "Content-Length": str(len(data)),
    }
    return {**kwargs, "body": chunks(), "headers": headers}


def install_send_hook(pool: Any) -> None:
    """Make ``pool.urlopen`` ask the current request's admission (#765)."""
    original = pool.urlopen

    def urlopen(method: str, url: str, *args: Any, **kwargs: Any) -> Any:
        send = _CURRENT_SEND.get()
        if send is None:
            return original(method, url, *args, **kwargs)
        if send.sent:
            msg = "A backfill chunk's request cannot be resent after a connection failure"
            raise RuntimeError(msg)
        if send.admission is not None and not send.admission.admit():
            msg = "The request was not sent: its caller stopped"
            raise SendNotAdmittedError(msg)
        attach = getattr(send.admission, "attach", None)
        if callable(attach):
            # An admitted request can be abandoned from here on.
            attach(send.abandon)
        send.sent = True
        admission = send.admission
        if admission is not None:
            # Handed off once urllib3 has written the body: the whole request
            # is on the socket. A request that fails before that ends its
            # caller's wait when submit_once returns.
            kwargs = _body_after_handoff(kwargs, send)
        return original(method, url, *args, **{**kwargs, "retries": False})

    pool.urlopen = urlopen
    # The connections tell the request when they write it, so that an
    # abandon can stop them.
    pool.pool_classes_by_scheme = {
        "http": _SendHTTPConnectionPool,
        "https": _SendHTTPSConnectionPool,
    }


class _SendConnectionMixin:
    """A connection that registers with the current ``submit_once`` request
    before it writes it, connected first (a plain HTTP connection otherwise
    connects inside its first write), so an abandon finds its socket."""

    def _new_conn(self) -> socket.socket:
        """The socket, with the name resolved under the connect timeout too
        (TS's timer covers its lookup): ``getaddrinfo`` cannot time out, so it
        runs on a daemon thread, and the TCP connect gets what is left."""
        conn: Any = self
        new_conn: Callable[[], socket.socket] = super()._new_conn  # type: ignore[misc]
        timeout = conn.timeout
        if _CURRENT_SEND.get() is None or not isinstance(timeout, (int, float)):
            return new_conn()
        deadline = time.monotonic() + timeout
        host = conn._dns_host
        addresses = _resolve_within(host, conn.port, timeout)
        last: BaseException | None = None
        for address in addresses:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            conn._dns_host = address
            conn.timeout = left
            try:
                return new_conn()
            except NewConnectionError as error:
                last = error
            finally:
                conn._dns_host = host
                conn.timeout = timeout
        if last is not None:
            raise last
        msg = f"Connection to {host} timed out. (connect timeout={timeout})"
        raise ConnectTimeoutError(self, msg)

    def request(self, method: str, url: str, *args: Any, **kwargs: Any) -> None:
        send = _CURRENT_SEND.get()
        if send is not None and send.admission is not None:
            if getattr(self, "sock", None) is None:
                self.connect()  # type: ignore[attr-defined]
            send.writing(self)
        super().request(method, url, *args, **kwargs)  # type: ignore[misc]


def _resolve_within(host: str, port: int, timeout: float) -> list[str]:
    """The addresses of ``host``, or a ``ConnectTimeoutError`` after
    ``timeout`` seconds: the lookup runs on a daemon thread left behind."""
    outcome: list[tuple[bool, object]] = []
    done = threading.Event()

    def resolve() -> None:
        try:
            infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
            outcome.append((True, [str(info[4][0]) for info in infos]))
        except BaseException as error:
            outcome.append((False, error))
        done.set()

    threading.Thread(target=resolve, name="chkit-send-resolve", daemon=True).start()
    if not done.wait(timeout):
        msg = f"Resolving {host} timed out. (connect timeout={timeout})"
        raise ConnectTimeoutError(None, msg)
    ok, value = outcome[0]
    if not ok:
        error = value if isinstance(value, BaseException) else RuntimeError(str(value))
        raise NameResolutionError(host, None, error)  # type: ignore[arg-type]
    return list(dict.fromkeys(value))  # type: ignore[call-overload]


class _SendHTTPConnection(_SendConnectionMixin, HTTPConnection):
    pass


class _SendHTTPSConnection(_SendConnectionMixin, HTTPSConnection):
    pass


class _SendHTTPConnectionPool(HTTPConnectionPool):
    ConnectionCls = _SendHTTPConnection


class _SendHTTPSConnectionPool(HTTPSConnectionPool):
    ConnectionCls = _SendHTTPSConnection


class _SingleAttemptPool:
    """Allow one driver HTTP send and disable urllib3's separate retry budget."""

    def __init__(self, pool: Any) -> None:
        self._pool = pool
        self._sent = False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pool, name)

    def request(self, *args: Any, **kwargs: Any) -> Any:
        if self._sent:
            msg = "A tracked migration request cannot be replayed after a connection failure"
            raise RuntimeError(msg)
        self._sent = True
        return self._pool.request(*args, **{**kwargs, "retries": False})


# QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING: a second delivery of the id, rejected
# while the first runs. It says nothing about that first one.
_SAME_ID_RUNNING = 216


def query_log_outcome(rows: list[dict[str, Any]]) -> QueryStatus:
    """The outcome query_log records for a query id, from its entries newest first (#767).

    A QueryFinish, then an ExceptionWhileProcessing, outranks an
    ExceptionBeforeStart, which a rejected duplicate delivery logs early; and
    that rejection is never the query's own failure. Two terminal entries (a
    redelivered request that ran twice) leave the outcome unknown: one of them
    may have applied part of its writes.
    """
    # Each entry once per server: one node the cluster lists twice is not a
    # second run.
    entries = {
        (row.get("server"), row.get("type"), row.get("event_at"), row.get("exception"))
        for row in rows
        if not _is_same_id_running(row)
    }
    if len(entries) > 1:
        return QueryStatus(status="unknown")
    finished = next((row for row in rows if str(row.get("type")) == "QueryFinish"), None)
    if finished is not None:
        return QueryStatus(
            status="finished",
            written_rows=_safe_int(finished.get("written_rows")),
            written_bytes=_safe_int(finished.get("written_bytes")),
            duration_ms=_safe_int(finished.get("query_duration_ms")),
        )
    failed = next(
        (row for row in rows if str(row.get("type")) == "ExceptionWhileProcessing"), None
    ) or next(
        (
            row
            for row in rows
            if str(row.get("type")) == "ExceptionBeforeStart" and not _is_same_id_running(row)
        ),
        None,
    )
    if failed is None:
        return QueryStatus(status="unknown")
    return QueryStatus(
        status="failed",
        duration_ms=_safe_int(failed.get("query_duration_ms")),
        error=str(failed.get("exception") or "") or None,
        before_start=str(failed.get("type")) == "ExceptionBeforeStart",
    )


def _is_same_id_running(row: dict[str, Any]) -> bool:
    return _safe_int(row.get("exception_code")) == _SAME_ID_RUNNING or (
        "QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING" in str(row.get("exception") or "")
    )


# The check a submit runs right before its request is sent, per thread: the
# submit driver is shared by concurrent submits (#767).
_SUBMIT_SEND = threading.local()

_T = TypeVar("_T")


class _NoReplayPool:
    """Never replay a sent request, for clients whose requests run concurrently.

    clickhouse-connect sends a request again when the server reset the
    connection, even with ``query_retries=0``, and urllib3 has a retry budget
    of its own. A replayed async submit could run its statement twice under
    one journaled id (#767). The reset is raised as an error the driver does
    not retry, so the poller decides the outcome from the server's record.
    """

    def __init__(self, pool: Any) -> None:
        self._pool = pool

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pool, name)

    def request(self, *args: Any, **kwargs: Any) -> Any:
        # The submitting thread's guard, before the request starts (#767).
        before_send = getattr(_SUBMIT_SEND, "before_send", None)
        if before_send is not None:
            before_send()
        try:
            return self._pool.request(*args, **{**kwargs, "retries": False})
        except HTTPError as error:
            if isinstance(error.__context__, ConnectionResetError):
                msg = f"The connection was reset after the request was sent ({error})"
                raise ConnectionError(msg) from error
            raise


# How long a submit may take to connect (#767): a submit the caller gave up
# on is excluded from sending once it connected or failed to, so this bounds
# how long the caller waits to know.
SUBMIT_CONNECT_TIMEOUT_SECONDS = 10.0
# How long writing a submit's request may take (#767): the run that gave up
# on the submit keeps its migrate lock until the write completed or failed.
SUBMIT_WRITE_TIMEOUT_SECONDS = 30.0


def guard_begin_write(guard: Any) -> None:
    """Start writing a request under the submit's guard (#767).

    A guard with ``begin_write`` refuses once the run gave up on the submit,
    and from here on holds the run's give-up until ``guard_end_write``: a
    request is either written whole (or its write failed) before the run
    stops, or never started.
    """
    begin = getattr(guard, "begin_write", None)
    if begin is not None:
        begin()


def guard_end_write(guard: Any) -> None:
    end = getattr(guard, "end_write", None)
    if end is not None:
        end()


class _GuardedSend:
    """The submitting thread's guard on writing each request.

    The connection is opened first (connection setup is not sending); the
    request's first ``send`` starts the guarded write, under the write
    timeout, and it ends once ``request`` returned or failed.
    """

    _guard: Any = None
    _writing: Any = None
    _timeout_before: Any = None

    def request(self, *args: Any, **kwargs: Any) -> None:
        self._guard = getattr(_SUBMIT_SEND, "before_send", None)
        try:
            super().request(*args, **kwargs)  # type: ignore[misc]
        finally:
            self._guard = None
            writing, self._writing = self._writing, None
            if writing is not None:
                if self.sock is not None:  # type: ignore[attr-defined]
                    self.sock.settimeout(self._timeout_before)  # type: ignore[attr-defined]
                guard_end_write(writing)

    def send(self, data: Any) -> None:
        guard, self._guard = self._guard, None
        if guard is not None:
            if self.sock is None:  # type: ignore[attr-defined]
                self.connect()  # type: ignore[attr-defined]
            try:
                guard_begin_write(guard)
            except BaseException:
                self.close()  # type: ignore[attr-defined]
                raise
            self._writing = guard
            self._timeout_before = self.sock.gettimeout()  # type: ignore[attr-defined]
            self.sock.settimeout(SUBMIT_WRITE_TIMEOUT_SECONDS)  # type: ignore[attr-defined]
        super().send(data)  # type: ignore[misc]


class _GuardedHTTPConnection(_GuardedSend, HTTPConnection):
    pass


class _GuardedHTTPSConnection(_GuardedSend, HTTPSConnection):
    pass


class _GuardedHTTPConnectionPool(HTTPConnectionPool):
    ConnectionCls = _GuardedHTTPConnection


class _GuardedHTTPSConnectionPool(HTTPSConnectionPool):
    ConnectionCls = _GuardedHTTPSConnection


def _use_ts_timeouts(client: Any) -> None:
    """Wait for a request as long as the TS client does, with its progress headers.

    TS sets ``request_timeout: 0`` (no timeout at all, connect included) and
    sends progress headers every 30 s, which keep a long query's connection
    alive through a proxy with an idle timeout. clickhouse-connect defaults to
    a 300 s read timeout and derives the progress interval from it (120 s), and
    rejects ``send_receive_timeout=None`` while it derives it, so both are set
    on the driver once it is open. The driver sends the interval only when the
    user may change settings, as TS sends progress settings on reads, and a
    setting passed with a query still wins, as in TS.
    """
    client.timeout = Timeout(connect=None, read=None)
    if client._progress_interval is not None:
        client._progress_interval = PROGRESS_INTERVAL_MS


def _safe_int(value: object) -> int | None:  # noqa: PLR0911
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            try:
                return int(float(value))
            except ValueError:
                return None
    return None


def _safe_round_ms(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(js_math_round(float(value) * 1000))
    if isinstance(value, str):
        try:
            return int(js_math_round(float(value) * 1000))
        except ValueError:
            return None
    return None


class ClickHouseConnectionError(RuntimeError):
    """Wraps a connection-time failure with a human-readable message.

    Mirrors the TS ``ClickHouseConnectionError`` shape — preserves the
    original cause for tooling that wants to inspect the underlying
    exception, while the ``str(error)`` form gives a friendly message
    that differentiates auth vs network failures.
    """


class _JsonInt(str):
    """A JSON integer, with the digits ClickHouse wrote."""


class _JsonFloat(str):
    """A JSON number with a fraction or an exponent, as ClickHouse wrote it."""


def parse_json_result(body: str | bytes) -> dict[str, Any]:
    """Parse a ClickHouse ``FORMAT JSON`` body without losing digits (#381).

    ClickHouse writes 64-bit and wider integers and Decimals as bare JSON
    numbers, and a Decimal read as a float loses digits. In a column whose type
    is or contains one of them, every number becomes a string of the digits
    ClickHouse sent, as ``output_format_json_quote_64bit_integers = 1`` and
    ``output_format_json_quote_decimals = 1`` would do. Sending those settings
    instead would fail for a ``readonly = 1`` user (#402). In a column whose
    type is or contains ``JSON``, ``Object`` or ``Dynamic``, only a number a
    float would change becomes a string, as TS ``parseJsonEachRowLine`` does
    (#438). Other numbers stay numbers. A statement without a result set (DDL,
    ``OPTIMIZE``) has an empty body, read as no rows. Same as TS ``parseJsonResult``.
    """
    if not body.strip():
        return {"data": [], "meta": [], "rows": 0}
    parsed: dict[str, Any] = json.loads(body, parse_int=_JsonInt, parse_float=_JsonFloat)
    modes = {
        column["name"]: _number_mode(column["type"]) for column in parsed.get("meta", [])
    }

    # Rows keyed by column name: data, totals (WITH TOTALS) and extremes.min/max.
    def restore_row(row: Any) -> Any:
        if not isinstance(row, dict):
            return _restore(row, "number")
        return {name: _restore(cell, modes.get(name, "number")) for name, cell in row.items()}

    def restore_entry(key: str, value: Any) -> Any:
        if key == "data":
            return [restore_row(row) for row in value]
        if key == "totals":
            return restore_row(value)
        if key == "extremes" and isinstance(value, dict):
            return {bound: restore_row(row) for bound, row in value.items()}
        return _restore(value, "number")

    return {key: restore_entry(key, value) for key, value in parsed.items()}


def _number_mode(column_type: str) -> _NumberMode:
    if _DYNAMIC_TYPE_RE.search(column_type):
        return "round_trip"
    return "digits" if _EXACT_TYPE_RE.search(column_type) else "number"


def _restore(value: Any, mode: _NumberMode) -> Any:
    if isinstance(value, (_JsonInt, _JsonFloat)):
        number = int(value) if isinstance(value, _JsonInt) else float(value)
        if mode == "number":
            return number
        if mode == "digits" or not _float_keeps_digits(value):
            return str(value)
        return number
    if isinstance(value, list):
        return [_restore(item, mode) for item in value]
    if isinstance(value, dict):
        return {key: _restore(item, mode) for key, item in value.items()}
    return value


def _float_keeps_digits(text: str) -> bool:
    """Whether a float prints back to these digits, as TS ``roundTripNumber`` checks."""
    if len(text) <= _DBL_DIG:
        return True
    return _canonical_decimal(text) == _canonical_decimal(repr(float(text)))


def _canonical_decimal(text: str) -> str:
    """A JSON number's value as ``<sign><significant digits>e<exponent>``.

    ``100000000000000000000`` and ``1e+20``, or ``0.10`` and ``0.1``, compare
    equal. Same as TS ``canonicalDecimal``.
    """
    match = _DECIMAL_RE.fullmatch(text)
    if match is None:
        return text
    sign, integer = match.group(1), match.group(2)
    fraction, exponent = match.group(3) or "", match.group(4) or "0"
    digits = integer + fraction
    first = next((index for index, digit in enumerate(digits) if digit != "0"), -1)
    if first == -1:
        return "0"
    return f"{sign}{digits[first:].rstrip('0')}e{len(integer) - first + int(exponent)}"


def is_unknown_database_error(error: BaseException) -> bool:
    """Return True if ``error`` looks like ClickHouse's UNKNOWN_DATABASE (code 81).

    The Python ``clickhouse-connect`` driver only exposes the error code as
    part of the message string. Matching on both the numeric code and the
    canonical name is more robust than either alone.
    """
    text = str(error)
    return "Code: 81" in text or "UNKNOWN_DATABASE" in text


_CLICKHOUSE_CODE_RE = re.compile(r"\bcode: (\d+)", re.IGNORECASE)
# REQUIRED_PASSWORD, AUTHENTICATION_FAILED: the TS client rethrows these as a
# plain error without a code (``wrapConnectionError``).
_AUTH_ERROR_CODES = frozenset({"194", "516"})


def clickhouse_error_code(error: BaseException) -> str | None:
    """The ClickHouse exception code (e.g. ``"60"``) of a server error, else None.

    The TS client exposes it as ``ClickHouseError.code``; ``clickhouse-connect``
    only puts it in the message (``Received ClickHouse exception, code: 60, ...``).
    """
    if not isinstance(error, DatabaseError):
        return None
    match = _CLICKHOUSE_CODE_RE.search(str(error))
    if match is None or match.group(1) in _AUTH_ERROR_CODES:
        return None
    return match.group(1)


# ``errorRe`` of ``@clickhouse/client``'s ``parseError``, which gives the TS
# ``ClickHouseError`` its message: the innermost exception's text, up to its
# ``(TYPE)`` marker.
_CLICKHOUSE_ERROR_RE = re.compile(
    r"(Code|Error): (?P<code>\d+).*Exception: (?P<message>.+?)"
    r"\((?P<type>(?=[A-Z0-9_]*[A-Z]{3})[A-Z0-9_]+)\)",
    re.DOTALL,
)


def clickhouse_error_message(error: BaseException) -> str:
    """The message of ``error``, as the TS CLI prints it.

    For a server error that is ClickHouse's own message, without
    ``clickhouse-connect``'s ``Received ClickHouse exception, code: N, server
    response: Code: N. DB::Exception:`` prefix and the ``(NAME) (for url ...)``
    suffix; for any other error ``str(error)``.
    """
    text = str(error)
    if isinstance(error, DatabaseError):
        match = _CLICKHOUSE_ERROR_RE.search(text)
        if match is not None:
            return match.group("message")
    return text


# NETWORK_MESSAGE_PATTERNS of the TS client, plus the texts Python's socket
# layer uses for the same failures.
_NETWORK_ERROR_PATTERNS = (
    (
        re.compile(
            r"ENOTFOUND|getaddrinfo|EAI_AGAIN|Was there a typo|Failed to resolve"
            r"|Name or service not known|nodename nor servname",
            re.IGNORECASE,
        ),
        "host not found",
    ),
    (re.compile(r"ECONNREFUSED|Connection refused", re.IGNORECASE), "connection refused"),
    (re.compile(r"ETIMEDOUT|timed out", re.IGNORECASE), "connection timed out"),
    (re.compile(r"ECONNRESET|Connection reset", re.IGNORECASE), "connection reset"),
    (re.compile(r"EHOSTUNREACH|No route to host", re.IGNORECASE), "host unreachable"),
)
_LOCALHOST_DEFAULT_URL_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1):8123/?$")


def _is_auth_error(text: str) -> bool:
    match = _CLICKHOUSE_CODE_RE.search(text)
    if match is not None and match.group(1) in _AUTH_ERROR_CODES:
        return True
    if "REQUIRED_PASSWORD" in text or "AUTHENTICATION_FAILED" in text:
        return True
    return re.search(r"authentication failed", text, re.IGNORECASE) is not None


def _url_without_credentials(url: str) -> str:
    parsed = urlparse(url)
    if "@" not in parsed.netloc:
        return url
    return parsed._replace(netloc=parsed.netloc.rpartition("@")[2]).geturl()


def format_connection_error(
    error: BaseException, url: str, username: str | None = None
) -> str | None:
    """The message for an authentication or network failure, else None.

    Port of TS ``formatConnectionError``: a wrong password reads as one line
    instead of the server's reset instructions, an unreachable server names
    the cause. Credentials in ``url`` are left out, as in TS.
    """
    text = str(error)
    shown_url = _url_without_credentials(url)
    if _is_auth_error(text):
        # A user in the URL is the one the client signs in as (see ``connect``).
        user = unquote(urlparse(url).username or "") or username
        who = f'user "{user}"' if user else "the configured user"
        return (
            f"Authentication failed for {who} at {shown_url}. "
            "Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD."
        )
    label = next(
        (label for pattern, label in _NETWORK_ERROR_PATTERNS if pattern.search(text)), None
    )
    if label is None:
        return None
    hint = (
        "\n  Hint: CLICKHOUSE_URL is not set — chkit fell back to the default localhost "
        "endpoint. Set CLICKHOUSE_URL to point at your ClickHouse instance."
        if _LOCALHOST_DEFAULT_URL_RE.match(url) and not os.environ.get("CLICKHOUSE_URL")
        else ""
    )
    return f"Could not connect to ClickHouse at {shown_url} ({label}){hint}"


def wrap_connection_error(
    error: BaseException, url: str, username: str | None = None
) -> NoReturn:
    """Raise a ``ClickHouseConnectionError`` with the `format_connection_error`
    message, or ``error`` itself when that does not recognize it (TS
    ``wrapConnectionError``)."""
    message = format_connection_error(error, url, username)
    if message is None:
        raise error
    raise ClickHouseConnectionError(message) from error
