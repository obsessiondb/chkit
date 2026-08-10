"""Strict ClickHouse client wrapper."""

from chkit.clickhouse.client import (
    ClickHouseClient,
    ClickHouseColumnMeta,
    ClickHouseConnectionError,
    ClickHouseJsonQueryResult,
    QueryResult,
    QueryStatus,
    format_connection_error,
    is_unknown_database_error,
    wrap_connection_error,
)

__all__ = [
    "ClickHouseClient",
    "ClickHouseColumnMeta",
    "ClickHouseConnectionError",
    "ClickHouseJsonQueryResult",
    "QueryResult",
    "QueryStatus",
    "format_connection_error",
    "is_unknown_database_error",
    "wrap_connection_error",
]
