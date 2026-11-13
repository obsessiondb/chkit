"""Tests for the small connection/error helpers on ``chkit.clickhouse``.

These don't need a live ClickHouse — they exercise the pure utility surface
(``insert`` row-shape coercion, ``is_unknown_database_error``,
``clickhouse_error_message``, ``format_connection_error`` auth-vs-network
branching, ``wrap_connection_error``).
"""

from __future__ import annotations

import threading
import time
from unittest.mock import MagicMock

import clickhouse_connect  # type: ignore[import-untyped]
import pytest
from clickhouse_connect.driver.exceptions import DatabaseError  # type: ignore[import-untyped]
from clickhouse_connect.driver.httpclient import HttpClient  # type: ignore[import-untyped]
from pytest_httpx import HTTPXMock
from urllib3 import Timeout
from urllib3.exceptions import ProtocolError

from chkit.clickhouse import (
    ClickHouseClient,
    ClickHouseConnectionError,
    format_connection_error,
    is_unknown_database_error,
    wrap_connection_error,
)
from chkit.clickhouse.client import clickhouse_error_message
from chkit.clickhouse.control import run_control_request
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


def test_tracked_execute_records_a_fresh_id_for_the_database_fallback() -> None:
    client, fake = _stub_client()
    fake.command.side_effect = [DatabaseError("Code: 81. UNKNOWN_DATABASE"), None]
    events: list[str] = []
    ids = iter(["first", "fallback"])

    def record() -> str:
        query_id = next(ids)
        events.append(query_id)
        return query_id

    client.execute_tracked("INSERT INTO t SELECT 1", lambda: events.append("check"), record,
                           {"max_threads": 2, "query_id": "ignored"})

    assert events == ["check", "first", "check", "check", "fallback", "check"]
    assert [call.kwargs["settings"] for call in fake.command.call_args_list] == [
        {"wait_end_of_query": 1, "async_insert": 0, "max_threads": 2, "query_id": "first"},
        {"wait_end_of_query": 1, "async_insert": 0, "max_threads": 2, "query_id": "fallback"},
    ]
    assert [call.kwargs["use_database"] for call in fake.command.call_args_list] == [True, False]


def test_tracked_execute_rechecks_after_durable_intent() -> None:
    client, fake = _stub_client()
    held = True

    def record() -> str:
        nonlocal held
        held = False
        return "never-sent"

    def check() -> None:
        if not held:
            raise RuntimeError("lock lost while recording intent")

    with pytest.raises(RuntimeError, match="lock lost while recording intent"):
        client.execute_tracked("INSERT INTO t SELECT 1", check, record)
    fake.command.assert_not_called()


def test_tracked_execute_does_not_replay_driver_http_requests() -> None:
    client, fake = _stub_client()
    pool = fake.http

    def command(*_args: object, **_kwargs: object) -> None:
        fake.http.request("POST", "http://localhost/")
        fake.http.request("POST", "http://localhost/")

    fake.command.side_effect = command
    with pytest.raises(RuntimeError, match="cannot be replayed"):
        client.execute_tracked("INSERT INTO t SELECT 1", lambda: None, lambda: "one-send")
    pool.request.assert_called_once_with("POST", "http://localhost/", retries=False)
    assert fake.http is pool


def test_tracked_execute_blocks_the_pinned_drivers_remote_close_retry() -> None:
    client, fake = _stub_client()
    fake.headers = {}
    fake.params = {}
    fake._send_progress = False
    fake._progress_interval = None
    fake._autogenerate_query_id = False
    fake.url = "http://localhost:8123"
    fake.server_host_name = None
    pool = fake.http
    error = ProtocolError("remote closed")
    error.__context__ = ConnectionResetError("reset")
    pool.request.side_effect = error

    def command(statement: str, **_kwargs: object) -> None:
        HttpClient._raw_request(fake, statement, {})

    fake.command.side_effect = command
    with pytest.raises(RuntimeError, match="cannot be replayed"):
        client.execute_tracked("INSERT INTO t SELECT 1", lambda: None, lambda: "one-send")
    assert pool.request.call_count == 1
    assert pool.request.call_args.kwargs["retries"] is False


def test_native_control_uses_a_separate_bounded_session_free_request(httpx_mock: HTTPXMock) -> None:
    client, fake = _stub_client()
    httpx_mock.add_response(text='{"query_id":"old-query","kill_status":"finished"}\n')
    result = client.query_control("KILL QUERY WHERE query_id = 'old-query' SYNC", 5000, query_id="receipt-control", settings={"log_queries": 1, "query_id": "ignored", "result_overflow_mode": "break", "max_result_rows": 1})
    assert result.rows == [{"query_id": "old-query", "kill_status": "finished"}]
    request = httpx_mock.get_request()
    assert request is not None
    assert request.url.params["database"] == "default"
    assert request.url.params["default_format"] == "JSONEachRow"
    assert request.url.params["query_id"] == "receipt-control"
    assert request.url.params["log_queries"] == "1"
    assert request.url.params["max_result_rows"] == "1"
    for name in ("result_overflow_mode", "group_by_overflow_mode", "set_overflow_mode", "timeout_overflow_mode", "read_overflow_mode"):
        assert request.url.params[name] == "throw"
    assert "session_id" not in request.url.params
    assert request.content == b"KILL QUERY WHERE query_id = 'old-query' SYNC"
    fake.query.assert_not_called()
    fake.command.assert_not_called()


def test_control_request_deadline_bounds_a_stuck_body() -> None:
    done = threading.Event()
    entered = threading.Event()

    def request(_deadline: float) -> None:
        entered.set()
        done.wait()

    started = time.monotonic()
    try:
        with pytest.raises(TimeoutError, match="Cancellation deadline expired"):
            run_control_request(request, 30)
        assert entered.is_set()
        assert time.monotonic() - started < 1
    finally:
        done.set()


def test_control_request_does_not_start_after_expiry() -> None:
    request = MagicMock()
    with pytest.raises(TimeoutError, match="Cancellation deadline expired"):
        run_control_request(request, 0)
    request.assert_not_called()


# ---------- submit ----------


def test_submit_runs_on_its_own_driver_without_a_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The submit request holds the session it is sent in until the query ends,
    so polling on the main driver's session would be locked out (TS sends it
    through a session-less client)."""
    drivers: list[tuple[MagicMock, dict[str, object]]] = []

    def fake_get_client(**kwargs: object) -> MagicMock:
        driver = MagicMock()
        drivers.append((driver, kwargs))
        return driver

    monkeypatch.setattr(clickhouse_connect, "get_client", fake_get_client)
    client = ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url="http://localhost:8123",
            username="default",
            password="pw",
            database="analytics",
            secure=False,
        )
    )
    assert client.submit("INSERT INTO t SELECT 1", query_id="q1", settings={"x": "1"}) == "q1"
    assert client.submit("INSERT INTO t SELECT 2", query_id="q2") == "q2"

    [(main, main_kwargs), (submit_driver, submit_kwargs)] = drivers
    main.command.assert_not_called()
    assert submit_driver.database == "analytics"
    assert submit_kwargs == {**main_kwargs, "autogenerate_session_id": False}
    assert [call.args for call in submit_driver.command.call_args_list] == [
        ("INSERT INTO t SELECT 1",),
        ("INSERT INTO t SELECT 2",),
    ]
    assert [call.kwargs for call in submit_driver.command.call_args_list] == [
        {"settings": {"x": "1", "query_id": "q1"}},
        {"settings": {"query_id": "q2"}},
    ]
    client.close()
    main.close.assert_called_once()
    submit_driver.close.assert_called_once()
    with pytest.raises(RuntimeError, match="closed"):
        client.submit("INSERT INTO t SELECT 3", query_id="q3")
    assert submit_driver.command.call_count == 2


@pytest.mark.parametrize(
    ("driver_interval", "expected_interval"),
    [
        # The driver derives 120 s from its 300 s read timeout; TS sends 30 s.
        ("120000", "30000"),
        # A user who cannot change settings gets no interval, as in TS.
        (None, None),
    ],
)
def test_every_driver_waits_without_a_timeout_as_ts(
    monkeypatch: pytest.MonkeyPatch,
    driver_interval: str | None,
    expected_interval: str | None,
) -> None:
    """TS's client has ``request_timeout: 0``: no connect or read timeout. The
    session driver and the submit driver match it, with TS's 30 s progress
    headers."""
    drivers: list[tuple[MagicMock, dict[str, object]]] = []

    def fake_get_client(**kwargs: object) -> MagicMock:
        driver = MagicMock()
        driver.timeout = Timeout(connect=10, read=300)
        driver._progress_interval = driver_interval
        drivers.append((driver, kwargs))
        return driver

    monkeypatch.setattr(clickhouse_connect, "get_client", fake_get_client)
    client = ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url="http://localhost:8123",
            username="default",
            password="pw",
            database="analytics",
            secure=False,
        )
    )
    client.submit("INSERT INTO t SELECT 1", query_id="q1")

    assert len(drivers) == 2
    for driver, kwargs in drivers:
        assert kwargs["connect_timeout"] is None
        assert (driver.timeout.connect_timeout, driver.timeout.read_timeout) == (None, None)
        assert driver._progress_interval == expected_interval
    client.close()


def test_submit_driver_still_opening_at_close_sends_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An interrupted async migrate closes the client while its submit thread
    may still open the submit driver: that driver is closed, never used."""
    opening = threading.Event()
    release = threading.Event()
    drivers: list[MagicMock] = []

    def fake_get_client(**kwargs: object) -> MagicMock:
        driver = MagicMock()
        drivers.append(driver)
        if kwargs.get("autogenerate_session_id") is False:
            opening.set()
            release.wait(timeout=30)
        return driver

    monkeypatch.setattr(clickhouse_connect, "get_client", fake_get_client)
    client = ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url="http://localhost:8123",
            username="default",
            password="",
            database="default",
            secure=False,
        )
    )
    errors: list[Exception] = []

    def submit() -> None:
        try:
            client.submit("INSERT INTO t SELECT 1", query_id="q1")
        except RuntimeError as error:
            errors.append(error)

    submitter = threading.Thread(target=submit)
    submitter.start()
    assert opening.wait(timeout=5)
    closer = threading.Thread(target=client.close)
    closer.start()
    # close() returns without waiting for the driver to open: it has no
    # connect timeout, so the wait could be unbounded (#661).
    closer.join(timeout=2)
    assert not closer.is_alive()
    assert drivers[0].close.called
    release.set()
    submitter.join(timeout=5)
    closer.join(timeout=5)

    [_main, submit_driver] = drivers
    submit_driver.command.assert_not_called()
    submit_driver.close.assert_called_once()
    assert [str(error) for error in errors] == ["ClickHouse client is closed."]


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


def test_format_connection_error_names_the_user_set_in_the_url() -> None:
    # The URL's user is the one the client signs in as, as in TS.
    msg = format_connection_error(
        DatabaseError(WRONG_PASSWORD_ERROR), "http://al%40ice:SeCrEtPw@localhost:8199", "default"
    )
    assert msg == (
        'Authentication failed for user "al@ice" at http://localhost:8199. '
        "Check CLICKHOUSE_USER / CLICKHOUSE_PASSWORD."
    )


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


@pytest.mark.parametrize("code", [None, "0"])
def test_native_control_accepts_zero_exception_header(
    httpx_mock: HTTPXMock, code: str | None,
) -> None:
    client, _fake = _stub_client()
    httpx_mock.add_response(text='{"n":0}\n', headers={"X-ClickHouse-Exception-Code": code} if code else {})
    assert client.query_control("SELECT 0 AS n", 1000).rows == [{"n": 0}]
