"""Tests for the small connection/error helpers on ``chkit.clickhouse``.

These don't need a live ClickHouse — they exercise the pure utility surface
(``insert`` row-shape coercion, ``is_unknown_database_error``,
``format_connection_error`` auth-vs-network branching,
``wrap_connection_error``).
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from chkit.clickhouse import (
    ClickHouseClient,
    ClickHouseConnectionError,
    format_connection_error,
    is_unknown_database_error,
    wrap_connection_error,
)
from chkit.core.model import ChxResolvedClickHouseConfig


def _stub_client() -> tuple[ClickHouseClient, MagicMock]:
    fake = MagicMock()
    cfg = ChxResolvedClickHouseConfig(
        url="http://localhost:8123",
        username="default",
        password="",
        database="default",
        secure=False,
    )
    return ClickHouseClient(fake, cfg), fake


# ---------- insert ----------


def test_insert_with_list_of_dicts_infers_columns() -> None:
    client, fake = _stub_client()
    client.insert("events", [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}])
    args, kwargs = fake.insert.call_args
    assert args[0] == "events"
    assert args[1] == [[1, "a"], [2, "b"]]
    assert kwargs["column_names"] == ["id", "name"]


def test_insert_with_list_of_lists_requires_column_names() -> None:
    client, _fake = _stub_client()
    with pytest.raises(ValueError, match="column_names"):
        client.insert("events", [[1, "a"]])


def test_insert_with_list_of_lists_passes_through() -> None:
    client, fake = _stub_client()
    client.insert("events", [[1, "a"]], column_names=["id", "name"])
    args, kwargs = fake.insert.call_args
    assert args[1] == [[1, "a"]]
    assert kwargs["column_names"] == ["id", "name"]


def test_insert_empty_rows_is_noop() -> None:
    client, fake = _stub_client()
    client.insert("events", [])
    fake.insert.assert_not_called()


def test_insert_passes_database_kwarg() -> None:
    client, fake = _stub_client()
    client.insert("events", [{"id": 1}], database="analytics")
    _, kwargs = fake.insert.call_args
    assert kwargs["database"] == "analytics"


# ---------- is_unknown_database_error ----------


def test_is_unknown_database_error_matches_code_81() -> None:
    err = RuntimeError(
        "Code: 81. DB::Exception: Database `foo` doesn't exist. (UNKNOWN_DATABASE)"
    )
    assert is_unknown_database_error(err) is True


def test_is_unknown_database_error_matches_name_only() -> None:
    err = RuntimeError("Server says: UNKNOWN_DATABASE foo")
    assert is_unknown_database_error(err) is True


def test_is_unknown_database_error_rejects_unrelated() -> None:
    assert is_unknown_database_error(RuntimeError("Code: 42. Anything else.")) is False


# ---------- format_connection_error ----------


def test_format_connection_error_detects_auth_via_password_hint() -> None:
    msg = format_connection_error(
        RuntimeError("Authentication failed: wrong password"),
        "https://ch.example.com",
        "lucas",
    )
    assert "Authentication failed" in msg
    assert "lucas" in msg
    assert "ch.example.com" in msg


def test_format_connection_error_detects_auth_via_code_193() -> None:
    msg = format_connection_error(
        RuntimeError("Code: 193: bad password"),
        "https://ch.example.com",
    )
    assert "Authentication failed" in msg


def test_format_connection_error_falls_back_to_network() -> None:
    msg = format_connection_error(
        RuntimeError("connect ECONNREFUSED 127.0.0.1:8123"),
        "http://127.0.0.1:8123",
    )
    assert "Could not connect" in msg
    assert "Verify the URL" in msg


def test_format_connection_error_handles_missing_username() -> None:
    msg = format_connection_error(
        RuntimeError("Authentication failed"),
        "https://ch.example.com",
    )
    assert "as user" not in msg


# ---------- wrap_connection_error ----------


def test_wrap_connection_error_returns_typed_exception() -> None:
    wrapped = wrap_connection_error(
        RuntimeError("Authentication failed"),
        "https://ch.example.com",
        "lucas",
    )
    assert isinstance(wrapped, ClickHouseConnectionError)
    assert "Authentication failed" in str(wrapped)
