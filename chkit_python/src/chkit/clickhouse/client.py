"""Thin, strictly-typed wrapper over ``clickhouse-connect``.

We intentionally expose a minimal surface — only what the CLI needs (execute
DDL, fetch rows of dictionaries, introspect databases/tables). The third-party
client returns ``Any`` extensively; this wrapper narrows it down.
"""

from __future__ import annotations

from typing import Any, Self
from urllib.parse import urlparse

import clickhouse_connect  # type: ignore[import-untyped]
from pydantic import BaseModel, ConfigDict

from chkit.core.model import ChxResolvedClickHouseConfig


class QueryResult(BaseModel):
    """Container for a SELECT result."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    column_names: list[str]
    rows: list[dict[str, Any]]


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

    def query(self, statement: str) -> QueryResult:
        """Run a SELECT and return rows as a list of dicts."""
        result = self._client.query(statement)
        column_names: list[str] = list(result.column_names)
        rows: list[dict[str, Any]] = [
            dict(zip(column_names, row, strict=True)) for row in result.result_rows
        ]
        return QueryResult(column_names=column_names, rows=rows)

    def list_databases(self) -> list[str]:
        result = self.query("SHOW DATABASES")
        return [str(row["name"]) for row in result.rows]

    def list_tables(self, database: str) -> list[str]:
        # Parameterized via format string is OK here: only safe identifiers.
        result = self.query(f"SHOW TABLES FROM {database}")
        return [str(row["name"]) for row in result.rows]
