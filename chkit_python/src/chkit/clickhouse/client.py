"""Thin, strictly-typed wrapper over ``clickhouse-connect``.

We intentionally expose a minimal surface — only what the CLI needs (execute
DDL, fetch rows of dictionaries, introspect databases/tables). The third-party
client returns ``Any`` extensively; this wrapper narrows it down.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from typing import Any, Literal, NoReturn, Self
from urllib.parse import unquote, urlparse

import clickhouse_connect  # type: ignore[import-untyped]
from clickhouse_connect.driver.exceptions import (  # type: ignore[import-untyped]
    DatabaseError,
)
from pydantic import BaseModel, ConfigDict

from chkit.clickhouse.replicas import all_replicas, resolve_replica_fanout
from chkit.core.model import ChxResolvedClickHouseConfig

# chkit prints its own one-line error, as TS silences @clickhouse/client's
# logger: without a handler, the driver's warnings (``Unexpected Http Driver
# Exception``) would reach stderr through logging's last-resort handler.
logging.getLogger("clickhouse_connect").addHandler(logging.NullHandler())

QueryStatusKind = Literal["running", "finished", "failed", "unknown"]

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


class ClickHouseClient:
    """Imperative client wrapper. Use as a context manager."""

    __slots__ = ("_client", "_config")

    def __init__(self, client: Any, config: ChxResolvedClickHouseConfig) -> None:
        self._client: Any = client
        self._config: ChxResolvedClickHouseConfig = config

    @classmethod
    def connect(cls, config: ChxResolvedClickHouseConfig) -> Self:
        """Connect using a resolved config block."""
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
            )
        except Exception as error:
            wrap_connection_error(error, config.url, config.username)
        client.database = config.database
        return cls(client, config)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    @property
    def database(self) -> str:
        return self._config.database

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
        """Run a statement (DDL or DML) without returning rows.

        ``settings`` are per-statement ClickHouse settings (mirrors the TS
        executor's ``command(sql, settings)``). As in TS, a statement that
        fails because the configured database does not exist is retried without
        it, which lets the ``CREATE DATABASE`` of a first migration run."""
        try:
            self._client.command(statement, settings=settings)
        except DatabaseError as error:
            if not is_unknown_database_error(error):
                raise
            self._client.command(statement, settings=settings, use_database=False)

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
            statement.strip().rstrip(";"), settings={"query_id": query_id}, fmt="JSON"
        )
        return ClickHouseJsonQueryResult.model_validate(
            {**parse_json_result(body), "query_id": query_id}
        )

    def submit(
        self,
        statement: str,
        query_id: str | None = None,
        settings: dict[str, Any] | None = None,
    ) -> str:
        """Fire-and-forget a query. Returns the assigned query_id.

        Used by ``chkit migrate --apply`` for long-running ``ALTER`` /
        ``OPTIMIZE`` statements: the server starts processing immediately
        and the CLI polls ``query_status`` until terminal. ``settings`` are
        sent with the query (TS ``submit(sql, queryId, settings)``).
        """
        qid = query_id or str(uuid.uuid4())
        # clickhouse-connect's command() has no query_id parameter; over HTTP
        # the id travels as a query parameter, which the driver forwards from
        # per-query settings. Verified live: the id lands in system.query_log.
        self._client.command(statement, settings={**(settings or {}), "query_id": qid})
        return qid

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
        self._client.insert(table, rows, column_names=cols, database=database)


    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
    ) -> QueryStatus:
        """Check whether a previously-submitted query is running / finished / failed.

        Polls ``system.processes`` first (running?), then falls back to
        ``system.query_log`` for the terminal state. The query runs on the
        replica that received it, so on a multi-replica target (#246) both are
        read on every replica of ``clickhouse.cluster`` (or ``default``)
        through ``clusterAllReplicas``. A replica that cannot be read is
        skipped, so a poll keeps going while one is down; ``every_replica``
        fails the read instead, so a status other than ``running`` means that
        no replica runs the query.
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

        after = after_time or "1970-01-01 00:00:00"
        log_sql = (
            "SELECT type, written_rows, written_bytes, query_duration_ms, exception "
            f"FROM {source('system.query_log')} "
            f"WHERE user = currentUser() AND query_id = '{query_id}' "
            "AND type IN ('QueryFinish', 'ExceptionWhileProcessing') "
            "AND is_initial_query = 1 "
            f"AND query_start_time >= parseDateTimeBestEffort('{after}') "
            "ORDER BY event_time DESC LIMIT 1"
        )
        log = self.query(log_sql, settings=read_settings)
        if not log.rows:
            return QueryStatus(status="unknown")

        row = log.rows[0]
        if str(row.get("type")) == "QueryFinish":
            return QueryStatus(
                status="finished",
                written_rows=_safe_int(row.get("written_rows")),
                written_bytes=_safe_int(row.get("written_bytes")),
                duration_ms=_safe_int(row.get("query_duration_ms")),
            )
        return QueryStatus(
            status="failed",
            duration_ms=_safe_int(row.get("query_duration_ms")),
            error=str(row.get("exception") or "") or None,
        )

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
        return round(float(value) * 1000)
    if isinstance(value, str):
        try:
            return round(float(value) * 1000)
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
