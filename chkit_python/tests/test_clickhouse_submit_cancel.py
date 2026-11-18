"""A submit the run gave up on is not sent once its connection opens (#767).

The run that stops an async statement without an outcome releases the
migrate lock, so a submit still connecting must never write its request after
that. Same guarantee as TS's ``AbortSignal`` on the submit.
"""

from __future__ import annotations

import contextlib
import socket
import threading
from typing import Any, cast

import httpcore
import pytest

from chkit.cli.commands.migrate_async_apply import _Submission
from chkit.clickhouse import client as client_module
from chkit_plugin_obsessiondb.credentials import Credentials
from chkit_plugin_obsessiondb.remote_executor import RemoteClickHouseClient


class _Server:
    """A TCP listener that records every byte a connection sends."""

    def __init__(self) -> None:
        self._sock = socket.socket()
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen()
        self.port = self._sock.getsockname()[1]
        self.received = b""
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        conn, _ = self._sock.accept()
        conn.settimeout(2)
        try:
            while chunk := conn.recv(4096):
                self.received += chunk
        except OSError:
            pass
        finally:
            conn.close()

    def close(self) -> None:
        self._thread.join(timeout=5)
        self._sock.close()


class _SlowConnection(client_module._GuardedHTTPConnection):
    """Its TCP connect waits until the test lets it through."""

    connecting = threading.Event()
    release = threading.Event()

    def connect(self) -> None:
        type(self).connecting.set()
        type(self).release.wait(timeout=5)
        super().connect()


def test_a_submit_given_up_while_it_connects_never_writes_its_request() -> None:
    server = _Server()
    outcome: list[Any] = []

    def submit(guard: _Submission) -> None:
        # The submitting thread's guard, as ClickHouseClient.submit sets it.
        client_module._SUBMIT_SEND.before_send = guard
        try:
            guard()
            conn = _SlowConnection("127.0.0.1", server.port, timeout=5)
            try:
                conn.request("POST", "/", body=b"INSERT INTO t SELECT 1")
            except BaseException as error:
                outcome.append(error)
                raise
        finally:
            client_module._SUBMIT_SEND.before_send = None

    submission = _Submission(submit)
    assert _SlowConnection.connecting.wait(timeout=5)
    excluded: list[bool] = []
    abandoning = threading.Thread(target=lambda: excluded.append(submission.abandon()))
    abandoning.start()
    # The run gave up between the guard's check and the first socket write.
    _SlowConnection.release.set()
    abandoning.join(timeout=10)
    assert excluded == [True]
    assert submission.wait() is not None
    server.close()
    assert server.received == b""
    assert outcome
    assert "not sent" in str(outcome[0])


def test_a_submit_that_connected_before_the_run_gave_up_is_sent() -> None:
    """A request already committed was sent before the run gave up: the
    abandon does not wait for its response."""
    server = _Server()
    committed = threading.Event()

    def submit(guard: _Submission) -> None:
        client_module._SUBMIT_SEND.before_send = guard
        try:
            guard()
            conn = client_module._GuardedHTTPConnection("127.0.0.1", server.port, timeout=5)
            conn.request("POST", "/", body=b"INSERT INTO t SELECT 1")
            committed.set()
            # The listener answers nothing; only the request bytes matter.
            with contextlib.suppress(OSError):
                conn.getresponse()
        finally:
            client_module._SUBMIT_SEND.before_send = None

    submission = _Submission(submit)
    assert committed.wait(timeout=5)
    assert submission.abandon() is True
    submission.wait()
    server.close()
    assert b"INSERT INTO t SELECT 1" in server.received


def test_a_remote_submit_given_up_while_it_connects_never_writes_its_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ObsessionDB remote executor's submit (httpx) has the same guard:
    a run that gives up while the request connects sends none of its bytes."""
    server = _Server()
    connecting = threading.Event()
    release = threading.Event()
    connect_tcp = httpcore.SyncBackend.connect_tcp

    def slow_connect_tcp(self: httpcore.SyncBackend, *args: Any, **kwargs: Any) -> Any:
        connecting.set()
        release.wait(timeout=5)
        return connect_tcp(self, *args, **kwargs)

    monkeypatch.setattr(httpcore.SyncBackend, "connect_tcp", slow_connect_tcp)
    remote = RemoteClickHouseClient(
        credentials=Credentials(access_token="t", base_url=f"http://127.0.0.1:{server.port}"),
        service_slug="svc",
    )

    submission = _Submission(
        lambda guard: remote.submit("INSERT INTO t SELECT 1", "qid", before_send=guard)
    )
    assert connecting.wait(timeout=5)
    excluded: list[bool] = []
    abandoning = threading.Thread(target=lambda: excluded.append(submission.abandon()))
    abandoning.start()
    # The run gave up between the guard's check and the first socket write.
    release.set()
    abandoning.join(timeout=10)
    assert excluded == [True]
    error = submission.wait()
    server.close()
    assert server.received == b""
    assert error is not None
    assert "not sent" in str(error)


class _PausedBeforeFirstWrite:
    """The submit's guard, with its thread paused right before the first
    write: connected, nothing sent yet."""

    def __init__(self, guard: _Submission) -> None:
        self._guard = guard
        self.paused = threading.Event()
        self.release = threading.Event()

    def __call__(self) -> None:
        self._guard()

    def first_write(self, write: Any) -> Any:
        self.paused.set()
        self.release.wait(timeout=10)
        return self._guard.first_write(write)


@pytest.mark.parametrize("transport", ["native", "remote"])
def test_a_submit_paused_before_its_first_write_never_sends_after_the_run_stopped(
    transport: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 5): the run gives up while the submit is connected but has
    written nothing, its wait runs out and it releases the lock; the submit
    then resumes, and no byte of it reaches the server."""
    # The run's wait for a connecting submit runs out at once.
    monkeypatch.setattr(
        "chkit.cli.commands.migrate_async_apply.SUBMIT_CONNECT_TIMEOUT_SECONDS", -4.9
    )
    server = _Server()
    paused: list[_PausedBeforeFirstWrite] = []

    def submit(guard: _Submission) -> None:
        pausing = _PausedBeforeFirstWrite(guard)
        paused.append(pausing)
        if transport == "remote":
            remote = RemoteClickHouseClient(
                credentials=Credentials(
                    access_token="t", base_url=f"http://127.0.0.1:{server.port}"
                ),
                service_slug="svc",
            )
            remote.submit("INSERT INTO t SELECT 1", "qid", before_send=cast(Any, pausing))
            return
        client_module._SUBMIT_SEND.before_send = pausing
        try:
            pausing()
            conn = client_module._GuardedHTTPConnection("127.0.0.1", server.port, timeout=5)
            conn.request("POST", "/", body=b"INSERT INTO t SELECT 1")
        finally:
            client_module._SUBMIT_SEND.before_send = None

    submission = _Submission(submit)
    deadline = threading.Event()
    while not paused and not deadline.wait(0.01):
        pass
    assert paused[0].paused.wait(timeout=5)
    # The poll budget ran out: the run gives up, its wait runs out, and it
    # would release the migrate lock here.
    assert submission.abandon() is False
    paused[0].release.set()
    error = submission.wait()
    server.close()
    assert server.received == b""
    assert error is not None
    assert "not sent" in str(error)
