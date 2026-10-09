"""Pytest fixtures shared across the suite."""

from __future__ import annotations

from typing import Any

import clickhouse_connect  # type: ignore[import-untyped]
import pytest

from tests.e2e_testkit import live_env_to_client_kwargs, resolve_live_env


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
    params = live_env_to_client_kwargs(resolve_live_env())
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
