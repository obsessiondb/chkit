"""Remote ClickHouse executor that proxies via ObsessionDB's workbench API.

1:1 port of ``packages/plugin-obsessiondb/src/query/remote-executor.ts``.

Exposes the same surface as the local :class:`ClickHouseClient` so existing
commands (``drift``, ``pull``, ``migrate``, ``query``) don't care whether
they're hitting a local Docker or a managed ObsessionDB instance:

- ``execute(sql)`` — fire-and-forget; raises on ``result.error``.
- ``query(sql)`` — returns rows as ``list[dict]``.
- ``query_json(sql)`` — returns the full
  :class:`ClickHouseJsonQueryResult` envelope.
- ``submit(sql, query_id?)`` — async query (proxies query_id via the
  ``settings`` field of the execute call).
- ``query_status(query_id)`` — polls ``system.processes`` then
  ``system.query_log`` via this same proxy.
- ``database`` — the org's default database (introspected from the first
  ``listSchemaObjects`` row when needed).

The class deliberately does NOT subclass ClickHouseClient: it just
implements the same method names so duck-typing works. That avoids
having to fake a ``clickhouse_connect`` Client object.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict

from chkit.clickhouse.client import (
    ClickHouseColumnMeta,
    ClickHouseJsonQueryResult,
    QueryResult,
    QueryStatus,
)
from chkit.clickhouse.introspect import (
    IntrospectedTable,
    SchemaObjectRef,
    list_schema_objects,
    list_table_details,
)
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.workbench_api import (
    WorkbenchExecuteResult,
    workbench_query_execute,
)


def _row_to_dict(row: Any, column_names: Sequence[str]) -> dict[str, Any]:
    """Normalize ``data`` rows — TS returns lists for unnamed, dicts otherwise."""
    if isinstance(row, dict):
        return dict(row)
    if isinstance(row, list):
        return {
            column_names[i] if i < len(column_names) else str(i): value
            for i, value in enumerate(row)
        }
    return {"value": row}


def normalize_query_data(
    result: WorkbenchExecuteResult,
) -> list[dict[str, Any]]:
    """Convert workbench result rows into plain dict rows."""
    column_names = [col.name for col in result.meta]
    return [_row_to_dict(row, column_names) for row in result.data]


def normalize_query_json_result(
    result: WorkbenchExecuteResult,
) -> ClickHouseJsonQueryResult:
    """Wrap workbench result as :class:`ClickHouseJsonQueryResult`."""
    return ClickHouseJsonQueryResult(
        data=normalize_query_data(result),
        meta=[
            ClickHouseColumnMeta(name=col.name, type=col.type) for col in result.meta
        ],
        rows=result.rows,
        statistics=result.statistics,
        query_id=result.query_id,
    )


def _raise_if_error(result: WorkbenchExecuteResult) -> None:
    if result.error:
        raise RuntimeError(result.error)


class RemoteClickHouseClient:
    """Drop-in replacement for :class:`chkit.clickhouse.client.ClickHouseClient`."""

    __slots__ = ("_credentials", "_database", "_service_slug")

    def __init__(
        self,
        *,
        credentials: Credentials,
        service_slug: str,
        database: str = "default",
    ) -> None:
        self._credentials: Credentials = credentials
        self._service_slug: str = service_slug
        self._database: str = database

    # ---- context manager parity ----

    def __enter__(self) -> RemoteClickHouseClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        # httpx clients are short-lived per-call; nothing to release.
        return

    @property
    def database(self) -> str:
        return self._database

    # ---- ClickHouseClient surface ----

    def execute(self, statement: str) -> None:
        result = workbench_query_execute(
            self._credentials, service_slug=self._service_slug, query=statement
        )
        _raise_if_error(result)

    def query(self, statement: str) -> QueryResult:
        result = workbench_query_execute(
            self._credentials, service_slug=self._service_slug, query=statement
        )
        _raise_if_error(result)
        column_names = [col.name for col in result.meta]
        return QueryResult(
            column_names=column_names,
            rows=normalize_query_data(result),
        )

    def query_json(self, statement: str) -> ClickHouseJsonQueryResult:
        result = workbench_query_execute(
            self._credentials, service_slug=self._service_slug, query=statement
        )
        _raise_if_error(result)
        return normalize_query_json_result(result)

    def submit(self, statement: str, query_id: str | None = None) -> str:
        settings: dict[str, str] | None = None
        if query_id is not None:
            settings = {"query_id": query_id}
        result = workbench_query_execute(
            self._credentials,
            service_slug=self._service_slug,
            query=statement,
            settings=settings,
        )
        _raise_if_error(result)
        return query_id or result.query_id or "submitted"

    def insert(
        self,
        table: str,
        values: list[dict[str, Any]],
        *,
        compressed: bool = False,
    ) -> None:
        """Insert dict rows into ``table`` via a synthesized ``INSERT … VALUES`` over workbench.

        Mirrors the TS ``RemoteClickHouseClient.insert``: builds the SQL
        client-side (workbench accepts a SQL string, not a typed insert call)
        and proxies via ``execute``. ``compressed`` is accepted for API parity
        but currently unused on the wire — workbench manages compression at
        the transport layer.
        """
        _ = compressed
        if not values:
            return
        first = values[0]
        columns = list(first.keys())
        rendered_rows = ", ".join(
            "(" + ", ".join(_render_sql_literal(row.get(col)) for col in columns) + ")"
            for row in values
        )
        column_list = ", ".join(columns)
        self.execute(
            f"INSERT INTO {table} ({column_list}) VALUES {rendered_rows}"
        )

    def list_schema_objects(self) -> list[SchemaObjectRef]:
        """List non-system schema objects via the standalone introspect helper."""
        return list_schema_objects(self)

    def list_table_details(
        self, databases: list[str]
    ) -> list[IntrospectedTable]:
        """Fetch full table shape for ``databases`` via the standalone helper."""
        return list_table_details(self, databases)

    def query_status(
        self, query_id: str, *, after_time: str | None = None
    ) -> QueryStatus:
        """Mirror of :meth:`ClickHouseClient.query_status`, proxied via workbench."""
        after_filter = (
            f" AND event_time >= '{after_time}'" if after_time is not None else ""
        )
        running = self.query(
            "SELECT query_id FROM system.processes "
            f"WHERE user = currentUser() AND query_id = '{query_id}' LIMIT 1"
        )
        if running.rows:
            return QueryStatus(status="running")
        log = self.query(
            "SELECT type, written_rows, written_bytes, query_duration_ms, exception "
            "FROM system.query_log "
            f"WHERE user = currentUser() AND query_id = '{query_id}'"
            "  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')"
            f"{after_filter}"
            " ORDER BY event_time DESC LIMIT 1"
        )
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


def _render_sql_literal(value: Any) -> str:
    """Render a Python value as a ClickHouse SQL literal for INSERT VALUES.

    Mirrors the TS ``RemoteClickHouseClient.insert`` literal rendering: NULL
    for None, bare numbers, booleans as 1/0, single-quoted escaped strings for
    everything else.
    """
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("\\", "\\\\").replace("'", "\\'")
    return f"'{text}'"


def _safe_int(value: Any) -> int | None:  # noqa: PLR0911
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


# ---- factory used by the get_context hook ----


class RemoteContextConfig(BaseModel):
    """Inputs the plugin's ``get_context`` hook resolves to build the executor."""

    model_config = ConfigDict(frozen=True, extra="ignore")

    service_slug: str
    database: str = "default"


def create_remote_executor(
    credentials: Credentials,
    *,
    service_slug: str,
    database: str = "default",
) -> RemoteClickHouseClient:
    return RemoteClickHouseClient(
        credentials=credentials,
        service_slug=service_slug,
        database=database,
    )


__all__ = [
    "RemoteClickHouseClient",
    "RemoteContextConfig",
    "create_remote_executor",
    "normalize_query_data",
    "normalize_query_json_result",
]
