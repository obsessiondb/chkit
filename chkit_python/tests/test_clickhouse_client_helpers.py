"""Tests for the small connection/error helpers on ``chkit.clickhouse``.

These don't need a live ClickHouse — they exercise the pure utility surface
(``insert`` row-shape coercion, ``is_unknown_database_error``,
``clickhouse_error_message``, ``format_connection_error`` auth-vs-network
branching, ``wrap_connection_error``).
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from clickhouse_connect.driver.exceptions import DatabaseError  # type: ignore[import-untyped]

from chkit.clickhouse import (
    ClickHouseClient,
    ClickHouseConnectionError,
    format_connection_error,
    is_unknown_database_error,
    wrap_connection_error,
)
from chkit.clickhouse.client import clickhouse_error_message
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


# ---------- execute ----------


def test_execute_retries_unknown_database_without_the_database() -> None:
    client, fake = _stub_client()
    fake.command.side_effect = [
        DatabaseError("Code: 81. DB::Exception: Database x does not exist. (UNKNOWN_DATABASE)"),
        None,
    ]

    client.execute("CREATE DATABASE IF NOT EXISTS x")

    assert fake.command.call_count == 2
    assert "use_database" not in fake.command.call_args_list[0].kwargs
    assert fake.command.call_args_list[1].kwargs["use_database"] is False


def test_execute_reraises_other_database_errors_without_retry() -> None:
    client, fake = _stub_client()
    fake.command.side_effect = DatabaseError("Code: 62. DB::Exception: Syntax error. (SYNTAX_ERROR)")

    with pytest.raises(DatabaseError, match="Code: 62"):
        client.execute("CREATE TABL x")

    assert fake.command.call_count == 1


# ---------- clickhouse_error_message ----------

# clickhouse-connect's text for a server error (chkit query "SELECT throwIf(1, 'boom')").
THROW_IF_ERROR = (
    "Received ClickHouse exception, code: 395, server response: Code: 395. "
    "DB::Exception: boom: while executing 'FUNCTION throwIf(1_UInt8 :: 1, 'boom'_String :: 2) "
    "-> throwIf(1_UInt8, 'boom'_String) UInt8 : 3'. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO) "
    "(for url http://localhost:8123)"
)


def test_clickhouse_error_message_is_the_server_message_as_in_ts() -> None:
    # What TS prints for the same query: the message of @clickhouse/client's
    # parseError, up to the (TYPE) marker.
    assert clickhouse_error_message(DatabaseError(THROW_IF_ERROR)) == (
        "boom: while executing 'FUNCTION throwIf(1_UInt8 :: 1, 'boom'_String :: 2) "
        "-> throwIf(1_UInt8, 'boom'_String) UInt8 : 3'. "
    )


def test_clickhouse_error_message_reads_the_innermost_cluster_exception() -> None:
    error = DatabaseError(
        "Received ClickHouse exception, code: 57, server response: Code: 57. "
        "DB::Exception: There was an error on [host:9000]: Code: 57. DB::Exception: "
        "Table db.t already exists. (TABLE_ALREADY_EXISTS) (version 26.3.1.1). "
        "(TABLE_ALREADY_EXISTS) (version 26.3.1.1) (for url http://localhost:8123)"
    )
    assert clickhouse_error_message(error) == "Table db.t already exists. "


def test_clickhouse_error_message_keeps_other_errors() -> None:
    assert clickhouse_error_message(RuntimeError(THROW_IF_ERROR)) == THROW_IF_ERROR
    assert clickhouse_error_message(DatabaseError("Connection refused")) == "Connection refused"


# ---------- format_connection_error ----------

# clickhouse-connect's text for a wrong password (abridged server blurb).
WRONG_PASSWORD_ERROR = (
    "Received ClickHouse exception, code: 194, server response: Code: 194. "
    "DB::Exception: default: Authentication failed: password is incorrect, or there is "
    "no user with such name\n\nIf you use ClickHouse Cloud, the password can be reset at "
    "https://clickhouse.cloud/\n\n. (REQUIRED_PASSWORD) (for url http://localhost:8123)"
)
CONNECTION_REFUSED_ERROR = (
    "Error HTTPConnectionPool(host='localhost', port=8199): Max retries exceeded with url: "
    "/?query_id=x (Caused by NewConnectionError(\"HTTPConnection(host='localhost', "
    "port=8199): Failed to establish a new connection: [Errno 61] Connection refused\")) "
    "executing HTTP request attempt 1 (http://localhost:8199)"
)


def test_format_connection_error_reports_a_wrong_password_as_ts() -> None:
    assert format_connection_error(
        DatabaseError(WRONG_PASSWORD_ERROR), "http://localhost:8123", "default"
    ) == (
        'Authentication failed for user "default" at http://localhost:8123. '
        "Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD."
    )


def test_format_connection_error_handles_missing_username() -> None:
    msg = format_connection_error(
        RuntimeError("Authentication failed"),
        "https://ch.example.com",
    )
    assert msg == (
        "Authentication failed for the configured user at https://ch.example.com. "
        "Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD."
    )


def test_format_connection_error_names_the_network_failure_as_ts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CLICKHOUSE_URL", raising=False)
    assert format_connection_error(
        DatabaseError(CONNECTION_REFUSED_ERROR), "http://localhost:8199", "default"
    ) == "Could not connect to ClickHouse at http://localhost:8199 (connection refused)"


def test_format_connection_error_hints_at_the_default_localhost_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CLICKHOUSE_URL", raising=False)
    msg = format_connection_error(
        DatabaseError(CONNECTION_REFUSED_ERROR), "http://localhost:8123"
    )
    assert msg == (
        "Could not connect to ClickHouse at http://localhost:8123 (connection refused)\n"
        "  Hint: CLICKHOUSE_URL is not set — chkit fell back to the default localhost "
        "endpoint. Set CLICKHOUSE_URL to point at your ClickHouse instance."
    )
    monkeypatch.setenv("CLICKHOUSE_URL", "http://localhost:8123")
    assert "Hint" not in (
        format_connection_error(DatabaseError(CONNECTION_REFUSED_ERROR), "http://localhost:8123")
        or ""
    )


def test_format_connection_error_leaves_out_credentials_in_the_url() -> None:
    msg = format_connection_error(
        DatabaseError(WRONG_PASSWORD_ERROR), "https://lucas:s3cret@ch.example.com:8443"
    )
    assert msg is not None
    assert "s3cret" not in msg
    assert "at https://ch.example.com:8443." in msg


def test_format_connection_error_ignores_other_errors() -> None:
    assert format_connection_error(DatabaseError(THROW_IF_ERROR), "http://localhost:8123") is None


# ---------- wrap_connection_error ----------


def test_wrap_connection_error_raises_a_typed_exception() -> None:
    cause = RuntimeError("Authentication failed")
    with pytest.raises(ClickHouseConnectionError, match="Authentication failed for user") as info:
        wrap_connection_error(cause, "https://ch.example.com", "lucas")
    assert info.value.__cause__ is cause


def test_wrap_connection_error_reraises_an_unrecognized_error() -> None:
    cause = DatabaseError(THROW_IF_ERROR)
    with pytest.raises(DatabaseError) as info:
        wrap_connection_error(cause, "http://localhost:8123")
    assert info.value is cause
