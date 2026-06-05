"""Pytest fixtures shared across the suite."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse

import clickhouse_connect  # type: ignore[import-untyped]
import pytest


def _resolve_clickhouse_env() -> dict[str, Any]:
    """Resolve ClickHouse connection params from env, defaulting to local Docker.

    Default for a fresh Docker run: ``http://localhost:8123`` with the
    ``default`` user and empty password. The TypeScript suite hard-fails on
    missing env, but the user's local dev workflow is "Docker on localhost
    with default config" — we honour that.
    """
    host = (os.environ.get("CLICKHOUSE_HOST") or "").strip()
    url = (os.environ.get("CLICKHOUSE_URL") or "").strip()
    if not url and host:
        url = f"https://{host}"
    if not url:
        url = "http://localhost:8123"

    username = (os.environ.get("CLICKHOUSE_USER") or "default").strip() or "default"
    password = os.environ.get("CLICKHOUSE_PASSWORD")
    if password is None:
        password = ""
    database = (os.environ.get("CLICKHOUSE_DB") or "default").strip() or "default"

    parsed = urlparse(url)
    host_only = parsed.hostname or "localhost"
    port = parsed.port
    secure = parsed.scheme == "https"
    if port is None:
        port = 8443 if secure else 8123

    return {
        "host": host_only,
        "port": port,
        "secure": secure,
        "username": username,
        "password": password,
        "database": database,
    }


class _QueryClient:
    """Tiny wrapper used by the e2e SQL validation tests.

    For ``EXPLAIN AST`` we only care that the server-side parser accepts the
    statement; we don't want clickhouse-connect's typed result decoder to try
    to interpret the AST text dump as typed columns. ``raw_query`` skips that.
    """

    def __init__(self, client: Any) -> None:
        self._client = client

    def query(self, sql: str) -> None:
        # raw_query returns bytes from the HTTP body; we discard them.
        self._client.raw_query(sql, fmt="TSVRaw")

    def close(self) -> None:
        self._client.close()


def _strip_for_explain(sql: str) -> str:
    """Strip trailing `;` and the optional `SYNC` keyword before EXPLAIN AST."""
    cleaned = sql.rstrip().removesuffix(";").rstrip()
    if cleaned.upper().endswith(" SYNC"):
        cleaned = cleaned[: -len(" SYNC")].rstrip()
    return cleaned


def _parse_version(raw: str) -> tuple[int, ...]:
    parts: list[int] = []
    for token in raw.split("."):
        digits = ""
        for ch in token:
            if ch.isdigit():
                digits += ch
            else:
                break
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


@pytest.fixture(scope="session")
def ch_client() -> Any:
    """Session-scoped ClickHouse client. Hard-fails if connection is impossible."""
    params = _resolve_clickhouse_env()
    try:
        client = clickhouse_connect.get_client(**params)
        # eager connection check
        client.query("SELECT 1")
    except Exception as exc:
        msg = (
            f"Failed to connect to ClickHouse at {params['host']}:{params['port']} "
            f"(secure={params['secure']}, user={params['username']}, "
            f"database={params['database']}). Set CLICKHOUSE_URL/CLICKHOUSE_PASSWORD "
            f"to override defaults. Original error: {exc!r}"
        )
        pytest.fail(msg, pytrace=False)
    wrapper = _QueryClient(client)
    yield wrapper
    wrapper.close()


@pytest.fixture(scope="session")
def ch_server_version(ch_client: Any) -> tuple[int, ...]:
    """Parse the server version once per session for feature gating."""
    raw = ch_client._client.query("SELECT version() AS v").result_rows[0][0]
    return _parse_version(str(raw))


@pytest.fixture
def assert_valid_sql(ch_client: _QueryClient):
    """Returns a callable that asserts a SQL statement parses via EXPLAIN AST."""

    def _assert(sql: str) -> None:
        cleaned = _strip_for_explain(sql)
        try:
            ch_client.query(f"EXPLAIN AST {cleaned}")
        except Exception as exc:
            pytest.fail(
                f"Invalid SQL:\n{cleaned}\n\nClickHouse error:\n{exc}",
                pytrace=False,
            )

    return _assert
