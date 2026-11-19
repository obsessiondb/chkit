"""A submit that never sent its request (#800).

A submit proves it was never sent only when its connect was refused or its
host did not resolve, before it wrote a byte. Every other failure may follow
a request the server read, and keeps the error a poll has to explain. The
twin of TS ``packages/clickhouse/src/submit-not-sent.test.ts``.
"""

from __future__ import annotations

import socket
import threading
from collections.abc import Callable
from typing import Any

import pytest
from urllib3.exceptions import NameResolutionError, NewConnectionError, ProtocolError

from chkit.clickhouse import client as client_module
from chkit.clickhouse.client import (
    ClickHouseClient,
    SubmitNotSentError,
    failed_before_sending,
)
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import resolve_live_env


class _Listener:
    """A TCP listener that hands each connection to ``serve``, recording what it read."""

    def __init__(self, serve: Callable[[socket.socket, _Listener], None]) -> None:
        self._sock = socket.socket()
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen()
        self.port: int = self._sock.getsockname()[1]
        self.received = b""
        self._serve = serve
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    def _accept(self) -> None:
        conn, _ = self._sock.accept()
        conn.settimeout(5)
        try:
            self._serve(conn, self)
        finally:
            conn.close()

    def read_request(self, conn: socket.socket) -> None:
        self.received += conn.recv(65536)

    def close(self) -> None:
        self._thread.join(timeout=5)
        self._sock.close()


def _closed_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port: int = sock.getsockname()[1]
    sock.close()
    return port


def _config(url: str) -> ChxResolvedClickHouseConfig:
    return ChxResolvedClickHouseConfig(
        url=url, username="default", password="", database="default", secure=False
    )


def _guard() -> None:
    """A submit's guard that never refuses, as migrate's is before a give-up."""


def _submit_error(client: ClickHouseClient) -> BaseException:
    with pytest.raises(Exception) as info:  # noqa: PT011 - the type is the assertion
        client.submit("INSERT INTO t SELECT 1", query_id="r800-id", before_send=_guard)
    return info.value


def _client_sending_to(port: int) -> ClickHouseClient:
    """A client whose submit driver opened against the live target, then sends
    its requests to ``port``: the open is not the submit's request."""
    env = resolve_live_env()
    config = ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database="default",
        secure=env.clickhouse_url.startswith("https:"),
    )
    client = ClickHouseClient(None, config)
    driver = client._submit_driver()
    driver.url = f"http://127.0.0.1:{port}"
    driver.http.clear()
    return client


def test_a_refused_connect_while_the_driver_opens_is_never_sent() -> None:
    port = _closed_port()
    error = _submit_error(ClickHouseClient(None, _config(f"http://127.0.0.1:{port}")))
    assert isinstance(error, SubmitNotSentError)
    assert str(error) == f"Could not connect to ClickHouse at http://127.0.0.1:{port} (connection refused)"


def test_a_host_that_does_not_resolve_is_never_sent() -> None:
    error = _submit_error(ClickHouseClient(None, _config("http://chkit-r800.invalid:8123")))
    assert isinstance(error, SubmitNotSentError)
    assert str(error) == "Could not connect to ClickHouse at http://chkit-r800.invalid:8123 (host not found)"


def test_a_refused_connect_of_the_request_is_never_sent() -> None:
    port = _closed_port()
    error = _submit_error(_client_sending_to(port))
    assert isinstance(error, SubmitNotSentError)
    assert "connection refused" in str(error)


def test_a_refused_connect_of_a_submit_without_a_guard_is_never_sent() -> None:
    """As in TS, the proof needs no guard: backfill submits without one."""
    port = _closed_port()
    with pytest.raises(SubmitNotSentError, match="connection refused"):
        _client_sending_to(port).submit("INSERT INTO t SELECT 1", query_id="r800-id")


def _reset_after_read(conn: socket.socket, listener: _Listener) -> None:
    listener.read_request(conn)
    # SO_LINGER 0: close() sends a RST.
    conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, b"\x01\x00\x00\x00\x00\x00\x00\x00")


def _close_after_accept(_conn: socket.socket, _listener: _Listener) -> None:
    pass


def _answer(status: int) -> Callable[[socket.socket, _Listener], None]:
    def serve(conn: socket.socket, listener: _Listener) -> None:
        listener.read_request(conn)
        conn.sendall(
            f"HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode()
        )

    return serve


@pytest.mark.parametrize(
    "serve",
    [_reset_after_read, _close_after_accept, _answer(401), _answer(502), _answer(524)],
    ids=["reset-after-read", "closed-after-accept", "401", "502", "524"],
)
def test_a_request_that_reached_the_server_may_have_been_sent(
    serve: Callable[[socket.socket, _Listener], None],
) -> None:
    listener = _Listener(serve)
    error = _submit_error(_client_sending_to(listener.port))
    listener.close()
    assert not isinstance(error, SubmitNotSentError)


def test_a_refused_connect_after_the_submit_wrote_a_byte_may_have_been_sent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A second connection's refusal says nothing about the first one's write."""
    listener = _Listener(lambda conn, lst: lst.read_request(conn))
    client = _client_sending_to(listener.port)
    driver = client._submit_driver()

    def command(*_args: Any, **_kwargs: Any) -> None:
        conn = client_module._GuardedHTTPConnection("127.0.0.1", listener.port, timeout=5)
        conn.request("POST", "/", body=b"INSERT INTO t SELECT 1")
        conn.close()
        refused = ConnectionRefusedError(61, "Connection refused")
        raise NewConnectionError(conn, "Failed to establish a new connection") from refused

    monkeypatch.setattr(driver, "command", command)
    error = _submit_error(client)
    listener.close()
    assert listener.received.startswith(b"POST / ")
    assert isinstance(error, NewConnectionError)


def _new_connection_error(cause: BaseException) -> NewConnectionError:
    try:
        raise NewConnectionError(None, "Failed to establish a new connection") from cause  # type: ignore[arg-type]
    except NewConnectionError as error:
        return error


def _wrapped(error: BaseException) -> RuntimeError:
    try:
        raise RuntimeError("request failed") from error
    except RuntimeError as wrapped:
        return wrapped


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (_new_connection_error(ConnectionRefusedError(61, "Connection refused")), True),
        (_wrapped(_new_connection_error(ConnectionRefusedError(61, "Connection refused"))), True),
        (_wrapped(NameResolutionError("h", None, socket.gaierror(8, "nodename"))), True),  # type: ignore[arg-type]
        (_new_connection_error(TimeoutError("timed out")), False),
        (_new_connection_error(OSError(65, "No route to host")), False),
        (_wrapped(ProtocolError("Connection aborted.", ConnectionResetError(54, "reset"))), False),
        (_wrapped(ConnectionRefusedError(61, "Connection refused")), False),
        (RuntimeError("Failed to establish a new connection: [Errno 61] Connection refused"), False),
        (RuntimeError("Could not connect to ClickHouse at http://127.0.0.1:1 (connection refused)"), False),
    ],
    ids=[
        "refused-connect",
        "wrapped-refused-connect",
        "failed-host-lookup",
        "connect-timeout",
        "unreachable-host",
        "reset",
        "refused-outside-a-connect",
        "text-names-refused",
        "wrapped-message",
    ],
)
def test_failed_before_sending(error: BaseException, expected: bool) -> None:
    assert failed_before_sending(error) is expected
