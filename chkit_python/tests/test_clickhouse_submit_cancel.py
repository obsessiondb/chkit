"""A submit the run gave up on is not sent once its connection opens (#767).

The run that stops an async statement without an outcome releases the
migrate lock, so a submit still connecting must never write its request after
that. Same guarantee as TS's ``AbortSignal`` on the submit.
"""

from __future__ import annotations

import contextlib
import inspect
import socket
import threading
import time
from types import SimpleNamespace
from typing import Any, cast

import httpcore
import httpx
import pytest

from chkit.cli.commands import migrate_async_apply
from chkit.cli.commands.migrate_async_apply import _Submission
from chkit.clickhouse import client as client_module
from chkit_plugin_obsessiondb import service_api
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

    def begin_write(self) -> None:
        self.paused.set()
        self.release.wait(timeout=10)
        self._guard.begin_write()

    def end_write(self) -> None:
        self._guard.end_write()


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


class _PausedWhileWriting(_PausedBeforeFirstWrite):
    """The submit's guard, with its thread paused after its write started."""

    def begin_write(self) -> None:
        self._guard.begin_write()
        self.paused.set()
        self.release.wait(timeout=10)


def _submit_through(transport: str, port: int, guard: Any, body: bytes) -> None:
    if transport == "remote":
        remote = RemoteClickHouseClient(
            credentials=Credentials(access_token="t", base_url=f"http://127.0.0.1:{port}"),
            service_slug="svc",
        )
        remote.submit(body.decode(), "qid", before_send=guard)
        return
    client_module._SUBMIT_SEND.before_send = guard
    try:
        guard()
        # No socket timeout, as the submit driver's (read=None): only the
        # write timeout bounds the write.
        conn = client_module._GuardedHTTPConnection("127.0.0.1", port, timeout=None)
        conn.request("POST", "/", body=body)
    finally:
        client_module._SUBMIT_SEND.before_send = None


@pytest.mark.parametrize("transport", ["native", "remote"])
def test_the_run_keeps_its_lock_while_the_submit_writes_its_request(
    transport: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 6): a run that gives up while the request is being written
    does not return, and so keeps its migrate lock, until the write ends,
    however long past the connect bound that is."""
    monkeypatch.setattr(
        "chkit.cli.commands.migrate_async_apply.SUBMIT_CONNECT_TIMEOUT_SECONDS", -4.9
    )
    server = _Server()
    paused: list[_PausedWhileWriting] = []

    def submit(guard: _Submission) -> None:
        pausing = _PausedWhileWriting(guard)
        paused.append(pausing)
        _submit_through(transport, server.port, pausing, b"INSERT INTO t SELECT 1")

    submission = _Submission(submit)
    deadline = threading.Event()
    while not paused and not deadline.wait(0.01):
        pass
    assert paused[0].paused.wait(timeout=5)
    returned = threading.Event()
    def abandon() -> None:
        submission.abandon()
        returned.set()

    abandoning = threading.Thread(target=abandon)
    abandoning.start()
    # Well past the connect bound (0.1 s here), the write is still under way.
    assert not returned.wait(timeout=1)
    paused[0].release.set()
    assert returned.wait(timeout=10)
    abandoning.join(timeout=5)
    submission.wait()
    server.close()
    assert b"INSERT INTO t SELECT 1" in server.received


class _SilentServer:
    """Accepts a connection and never reads from it."""

    def __init__(self) -> None:
        self._sock = socket.socket()
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen()
        self.port = self._sock.getsockname()[1]
        self._conns: list[socket.socket] = []
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    def _accept(self) -> None:
        with contextlib.suppress(OSError):
            conn, _ = self._sock.accept()
            conn.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            self._conns.append(conn)

    def close(self) -> None:
        for conn in self._conns:
            conn.close()
        self._sock.close()


@pytest.mark.parametrize("transport", ["native", "remote"])
def test_a_request_write_that_stalls_ends_at_the_write_timeout(
    transport: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 6): the run waits for a stalled write only until the
    submit's write timeout fires; the submit then fails."""
    monkeypatch.setattr(client_module, "SUBMIT_WRITE_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setattr(
        "chkit_plugin_obsessiondb.service_api.SUBMIT_WRITE_TIMEOUT_SECONDS", 0.5
    )
    server = _SilentServer()
    started = threading.Event()

    class _Started:
        def __init__(self, guard: _Submission) -> None:
            self._guard = guard

        def __call__(self) -> None:
            self._guard()

        def begin_write(self) -> None:
            self._guard.begin_write()
            started.set()

        def end_write(self) -> None:
            self._guard.end_write()

    # Far more than the socket buffers hold while nobody reads.
    body = b"INSERT INTO t SELECT 1 -- " + b"x" * (64 * 1024 * 1024)
    submission = _Submission(
        lambda guard: _submit_through(transport, server.port, _Started(guard), body)
    )
    assert started.wait(timeout=5)
    began = time.monotonic()
    submission.abandon()
    assert time.monotonic() - began < 10
    assert submission.wait() is not None
    server.close()


class _TunnelStream(httpcore.NetworkStream):
    """A proxy's tunnel: CONNECT is answered once the test lets it through,
    then TLS to the origin; every origin byte is recorded."""

    def __init__(self, state: dict[str, Any]) -> None:
        self._state = state

    def write(self, buffer: bytes, timeout: float | None = None) -> None:
        _ = timeout
        if buffer.startswith(b"CONNECT "):
            self._state["connect"].set()
            return
        if buffer:  # the CONNECT's end of message writes nothing
            self._state["origin"].append(buffer)

    def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        _ = (max_bytes, timeout)
        self._state["release"].wait(timeout=10)
        return b"HTTP/1.1 200 Connection established\r\n\r\n"

    def close(self) -> None:
        pass

    def start_tls(self, *args: Any, **kwargs: Any) -> httpcore.NetworkStream:
        _ = (args, kwargs)
        return self

    def get_extra_info(self, info: str) -> Any:
        _ = info


def test_a_remote_submit_given_up_during_its_proxy_tunnel_never_sends_its_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#767 (round 6): through an HTTPS proxy, the CONNECT and the TLS
    handshake are connection setup. A run that gives up while the tunnel is
    set up, and whose wait runs out, never gets the origin request sent once
    the tunnel opens."""
    monkeypatch.setattr(
        "chkit.cli.commands.migrate_async_apply.SUBMIT_CONNECT_TIMEOUT_SECONDS", -4.9
    )
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    state: dict[str, Any] = {
        "connect": threading.Event(),
        "release": threading.Event(),
        "origin": [],
    }
    monkeypatch.setattr(
        httpcore.SyncBackend, "connect_tcp", lambda _self, *_a, **_k: _TunnelStream(state)
    )
    remote = RemoteClickHouseClient(
        credentials=Credentials(access_token="t", base_url="https://console.invalid"),
        service_slug="svc",
    )
    submission = _Submission(
        lambda guard: remote.submit("INSERT INTO t SELECT 1", "qid", before_send=guard)
    )
    assert state["connect"].wait(timeout=5)
    submission.abandon()
    state["release"].set()
    error = submission.wait()
    assert error is not None
    assert "not sent" in str(error)
    assert state["origin"] == []


@pytest.mark.parametrize("proxy", [False, True])
def test_the_httpx_guard_reaches_every_pool_through_its_network_backend(
    proxy: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 6): the remote submit's guard sits on httpcore's private
    ``_network_backend`` of each pool. A release of httpx or httpcore that
    renames or drops it fails here, instead of submits going unguarded."""
    if proxy:
        monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
    with httpx.Client() as http:
        service_api._guard_first_write(http, object())
        pools = [t._pool for t in [http._transport, *http._mounts.values()] if t is not None]  # type: ignore[attr-defined]
    assert pools
    for pool in pools:
        assert isinstance(pool._network_backend, service_api._GuardedBackend)
        # httpcore builds each connection with that backend.
        assert "network_backend" in inspect.signature(httpcore.HTTPConnection).parameters


def _interrupted_poll(submission: _Submission, monkeypatch: pytest.MonkeyPatch) -> None:
    """The poller, interrupted by Ctrl-C at its first sleep."""

    def interrupt(_seconds: float) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", interrupt)
    migrate_async_apply._poll_until_terminal(
        input_=cast(Any, SimpleNamespace(poll_interval_seconds=0)),
        migration_state=None,
        query_id="qid",
        poll_after_time="",
        submission=submission,
        started_at="",
        fingerprint="",
    )


@pytest.mark.parametrize("transport", ["native", "remote"])
def test_ctrl_c_while_the_submit_connects_never_lets_it_send(
    transport: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 7): Ctrl-C gives the submit up through its guard before the
    run unwinds to the lock release, so a submit still connecting never
    writes its request once it connects."""
    monkeypatch.setattr(migrate_async_apply, "SUBMIT_CONNECT_TIMEOUT_SECONDS", -4.9)
    server = _Server()
    paused: list[_PausedBeforeFirstWrite] = []

    def submit(guard: _Submission) -> None:
        pausing = _PausedBeforeFirstWrite(guard)
        paused.append(pausing)
        _submit_through(transport, server.port, pausing, b"INSERT INTO t SELECT 1")

    submission = _Submission(submit)
    deadline = threading.Event()
    while not paused and not deadline.wait(0.01):
        pass
    assert paused[0].paused.wait(timeout=5)
    with pytest.raises(KeyboardInterrupt):
        _interrupted_poll(submission, monkeypatch)
    assert submission.abandoned
    paused[0].release.set()
    error = submission.wait()
    server.close()
    assert server.received == b""
    assert error is not None
    assert "not sent" in str(error)


@pytest.mark.parametrize("transport", ["native", "remote"])
def test_ctrl_c_while_the_submit_writes_waits_for_the_write(
    transport: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 7): Ctrl-C during a blocked request write unwinds, and so
    releases the lock, only once the write ended."""
    monkeypatch.setattr(migrate_async_apply, "SUBMIT_CONNECT_TIMEOUT_SECONDS", -4.9)
    server = _Server()
    paused: list[_PausedWhileWriting] = []

    def submit(guard: _Submission) -> None:
        pausing = _PausedWhileWriting(guard)
        paused.append(pausing)
        _submit_through(transport, server.port, pausing, b"INSERT INTO t SELECT 1")

    submission = _Submission(submit)
    deadline = threading.Event()
    while not paused and not deadline.wait(0.01):
        pass
    assert paused[0].paused.wait(timeout=5)
    unwound = threading.Event()

    def poll() -> None:
        with contextlib.suppress(KeyboardInterrupt):
            _interrupted_poll(submission, monkeypatch)
        unwound.set()

    polling = threading.Thread(target=poll)
    polling.start()
    assert not unwound.wait(timeout=1)
    paused[0].release.set()
    assert unwound.wait(timeout=10)
    polling.join(timeout=5)
    submission.wait()
    server.close()
    assert b"INSERT INTO t SELECT 1" in server.received
