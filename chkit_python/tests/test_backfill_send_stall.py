"""A chunk send whose TLS handshake never completes (#765, Opus critic item 1).

Port of the TS ``a send whose TLS handshake never completes`` cases in
``packages/plugin-backfill/src/run-lock.test.ts``: a load balancer or TLS
terminator accepts the TCP connection and never answers the ClientHello. The
interrupt abandons the stalled send after its handoff wait, releases the lock
and says the chunk may have run; without an interrupt, the connect timeout
fails the run.

clickhouse-connect sends probe queries as it opens a driver, so the driver
opens against the test target, and only the INSERT's connection is sent to a
server that accepts TCP and never answers TLS.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from chkit_plugin_backfill.run_lock import run_lock_path
from tests.e2e_testkit import resolve_live_env

PLAN_ID = "0123456789abcdef"
SRC = Path(__file__).resolve().parents[1] / "src"


@pytest.fixture
def silent_server() -> Iterator[tuple[int, list[socket.socket]]]:
    """Accepts TCP connections and never answers the TLS ClientHello."""
    listener = socket.create_server(("127.0.0.1", 0))
    connections: list[socket.socket] = []
    done = threading.Event()

    def accept() -> None:
        listener.settimeout(0.1)
        while not done.is_set():
            try:
                connection, _address = listener.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            connections.append(connection)

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    yield listener.getsockname()[1], connections
    done.set()
    thread.join(1)
    for connection in connections:
        connection.close()
    listener.close()


def _script(lock_path: Path, silent_port: int, connect_timeout_ms: int, handoff: str) -> str:
    env = resolve_live_env()
    return f"""
import json, socket, ssl
import urllib3.connection, urllib3.connectionpool
import chkit.clickhouse.client as client
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.async_backfill import execute_backfill
from chkit_plugin_backfill.plugin import _ThreadLocalExecutor
from chkit_plugin_backfill.run_lock import with_run_lock

client.SEND_CONNECT_TIMEOUT_MS = {connect_timeout_ms}

# The INSERT gets a connection of its own, to the silent server.
get_conn = urllib3.connectionpool.HTTPConnectionPool._get_conn
def fresh_conn(self, timeout=None):
    if client._CURRENT_SEND.get() is not None:
        return self._new_conn()
    return get_conn(self, timeout)
urllib3.connectionpool.HTTPConnectionPool._get_conn = fresh_conn

new_conn = urllib3.connection.HTTPConnection._new_conn
def stalled_tls(self):
    if client._CURRENT_SEND.get() is None:
        return new_conn(self)
    raw = socket.create_connection(("127.0.0.1", {silent_port}), timeout=self.timeout)
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context.wrap_socket(raw, server_hostname="localhost")
urllib3.connection.HTTPConnection._new_conn = stalled_tls

config = ChxResolvedClickHouseConfig(
    url={env.clickhouse_url!r}, username={env.clickhouse_user!r},
    password={env.clickhouse_password!r}, database={env.clickhouse_database!r},
    secure={env.clickhouse_url.startswith("https")!r},
)

def body(stop):
    return execute_backfill(
        executor=_ThreadLocalExecutor(config), plan_id={PLAN_ID!r}, chunk_ids=["c1"],
        build_query=lambda _c: "INSERT INTO t SELECT 1", poll_interval_ms=10, stop=stop,
        handoff_timeout_ms={handoff},
        on_progress=lambda p: print("checkpoint " + json.dumps(
            p["c1"].model_dump(by_alias=True, exclude_none=True)), flush=True),
    )

with_run_lock({str(lock_path)!r}, {PLAN_ID!r}, body)
"""


def _spawn(script: str) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-c", script],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "PYTHONPATH": str(SRC)},
    )


def _last_checkpoint(stdout: str) -> object:
    lines = [line for line in stdout.splitlines() if line.startswith("checkpoint ")]
    return json.loads(lines[-1][len("checkpoint ") :]) if lines else None


def test_an_interrupt_abandons_the_stalled_send_releases_the_lock_and_says_it_may_have_run(
    tmp_path: Path, silent_server: tuple[int, list[socket.socket]]
) -> None:
    port, connections = silent_server
    lock_path = run_lock_path(tmp_path / "runs", PLAN_ID)
    # A connect timeout longer than the test: only the handoff wait ends it.
    child = _spawn(_script(lock_path, port, 600_000, "500"))
    deadline = time.monotonic() + 20
    while not connections and time.monotonic() < deadline and child.poll() is None:
        time.sleep(0.01)
    assert connections, child.communicate(timeout=5)
    started = time.monotonic()

    child.send_signal(signal.SIGINT)
    stdout, stderr = child.communicate(timeout=20)
    elapsed = time.monotonic() - started

    assert child.returncode == 130, f"{stdout}\n{stderr}"
    assert elapsed < 5
    assert not lock_path.exists()
    assert (
        f"Backfill plan {PLAN_ID}: interrupted (SIGINT). No new chunk was submitted, and the "
        "lock is released; a chunk already submitted keeps running on the server, and a "
        "resume attaches to it. The send of chunk c1 did not reach the server in time and was "
        "abandoned: it may still have reached it, so its attempt stays recorded as one that "
        "may have run. Unless system.query_log shows its outcome, a resume stops on it, and "
        "only --accept-unknown replays it."
    ) in stderr
    assert _last_checkpoint(stdout) == {
        "status": "pending",
        "queryId": f"backfill-{PLAN_ID}-c1",
        "singleSend": True,
    }


def test_without_an_interrupt_the_connect_timeout_fails_the_run_and_keeps_the_attempt(
    tmp_path: Path, silent_server: tuple[int, list[socket.socket]]
) -> None:
    port, _connections = silent_server
    lock_path = run_lock_path(tmp_path / "runs", PLAN_ID)
    child = _spawn(_script(lock_path, port, 300, "None"))

    stdout, stderr = child.communicate(timeout=30)

    assert child.returncode not in (0, None), f"{stdout}\n{stderr}"
    assert (
        f"Backfill plan {PLAN_ID}: the send of chunk c1 (query_id backfill-{PLAN_ID}-c1) "
        "failed: The request could not connect and be written within 300 ms"
    ) in stderr
    assert (
        "so its attempt stays recorded as one that may have run. Unless system.query_log "
        "shows its outcome, a resume stops on it, and only --accept-unknown replays it."
    ) in stderr
    assert not lock_path.exists()
    assert _last_checkpoint(stdout) == {
        "status": "pending",
        "queryId": f"backfill-{PLAN_ID}-c1",
        "singleSend": True,
    }
