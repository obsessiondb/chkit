"""Thin, strictly-typed wrapper over ``clickhouse-connect``.

We intentionally expose a minimal surface — only what the CLI needs (execute
DDL, fetch rows of dictionaries, introspect databases/tables). The third-party
client returns ``Any`` extensively; this wrapper narrows it down.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal, Self
from urllib.parse import urlparse

import clickhouse_connect  # type: ignore[import-untyped]
from pydantic import BaseModel, ConfigDict

from chkit.core.model import ChxResolvedClickHouseConfig

QueryStatusKind = Literal["running", "finished", "failed", "unknown"]


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
    """

    model_config = ConfigDict(frozen=True)

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
        host = parsed.hostname
        if host is None:
            msg = f"Invalid ClickHouse URL (missing host): {config.url}"
            raise ValueError(msg)
        port = parsed.port
        if port is None:
            port = 8443 if config.secure else 8123

        client = clickhouse_connect.get_client(
            host=host,
            port=port,
            username=config.username,
            password=config.password,
            database=config.database,
            secure=config.secure,
        )
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

    def execute(self, statement: str) -> None:
        """Run a statement (DDL or DML) without returning rows."""
        self._client.command(statement)

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
        """Run a SELECT and return a full envelope with meta + statistics."""
        result = self._client.query(statement)
        column_names: list[str] = list(result.column_names)
        column_types: list[Any] = list(result.column_types)
        data = [
            dict(zip(column_names, row, strict=True)) for row in result.result_rows
        ]
        meta = [
            ClickHouseColumnMeta(name=name, type=str(typ))
            for name, typ in zip(column_names, column_types, strict=True)
        ]
        summary = getattr(result, "summary", None)
        statistics: dict[str, Any] | None = None
        if isinstance(summary, dict):
            statistics = dict(summary)
        query_id_attr = getattr(result, "query_id", None)
        query_id = str(query_id_attr) if query_id_attr is not None else None
        return ClickHouseJsonQueryResult(
            data=data,
            meta=meta,
            rows=len(data),
            statistics=statistics,
            query_id=query_id,
        )

    def submit(self, statement: str, query_id: str | None = None) -> str:
        """Fire-and-forget a query. Returns the assigned query_id.

        Used by ``chkit migrate --apply`` for long-running ``ALTER`` /
        ``OPTIMIZE`` statements: the server starts processing immediately
        and the CLI polls ``query_status`` until terminal.
        """
        qid = query_id or str(uuid.uuid4())
        # clickhouse-connect's command() has no query_id parameter; over HTTP
        # the id travels as a query parameter, which the driver forwards from
        # per-query settings. Verified live: the id lands in system.query_log.
        self._client.command(statement, settings={"query_id": qid})
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
        self, query_id: str, *, after_time: str | None = None
    ) -> QueryStatus:
        """Check whether a previously-submitted query is running / finished / failed.

        Polls ``system.processes`` first (running?), then falls back to
        ``system.query_log`` for the terminal state. Uses plain (non-cluster)
        system tables; the TS version uses ``clusterAllReplicas('cluster', ...)``
        which assumes ObsessionDB-style cluster naming and isn't portable across
        bare-CH installs.
        """
        running_sql = (
            "SELECT read_rows, read_bytes, written_rows, written_bytes, elapsed "
            f"FROM system.processes WHERE user = currentUser() AND query_id = '{query_id}'"
        )
        running = self.query(running_sql)
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
            "FROM system.query_log "
            f"WHERE user = currentUser() AND query_id = '{query_id}' "
            "AND type IN ('QueryFinish', 'ExceptionWhileProcessing') "
            "AND is_initial_query = 1 "
            f"AND query_start_time >= parseDateTimeBestEffort('{after}') "
            "ORDER BY event_time DESC LIMIT 1"
        )
        log = self.query(log_sql)
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


def is_unknown_database_error(error: BaseException) -> bool:
    """Return True if ``error`` looks like ClickHouse's UNKNOWN_DATABASE (code 81).

    The Python ``clickhouse-connect`` driver only exposes the error code as
    part of the message string. Matching on both the numeric code and the
    canonical name is more robust than either alone.
    """
    text = str(error)
    return "Code: 81" in text or "UNKNOWN_DATABASE" in text


_AUTH_HINTS = (
    "authentication",
    "auth failed",
    "wrong password",
    "user not allowed",
    "Code: 192",  # AUTHENTICATION_FAILED
    "Code: 193",  # WRONG_PASSWORD
    "Code: 516",  # AUTHENTICATION_FAILED (newer CH versions)
)


def format_connection_error(
    error: BaseException, url: str, username: str | None = None
) -> str:
    """Build a human-readable message differentiating auth vs network failures.

    Used to wrap raw driver exceptions before re-raising, so the CLI surfaces
    a clear "wrong password vs. server unreachable" hint instead of a stack
    trace.
    """
    text = str(error)
    user_part = f" as user '{username}'" if username else ""
    if any(hint in text for hint in _AUTH_HINTS):
        return (
            f"Authentication failed against {url}{user_part}: {text}. "
            "Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD."
        )
    return (
        f"Could not connect to ClickHouse at {url}{user_part}: {text}. "
        "Verify the URL and that the server is reachable."
    )


def wrap_connection_error(
    error: BaseException, url: str, username: str | None = None
) -> ClickHouseConnectionError:
    """Raise a ``ClickHouseConnectionError`` with a formatted, friendly message.

    Use at the call site that wraps ``ClickHouseClient.connect(...)``::

        try:
            client = ClickHouseClient.connect(config)
        except Exception as cause:
            raise wrap_connection_error(cause, config.url, config.username)
            # noqa: TRY301
    """
    return ClickHouseConnectionError(
        format_connection_error(error, url, username)
    )
