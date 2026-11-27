"""Port of ``packages/plugin-backfill/src/run-lock.test.ts`` (#765)."""

from __future__ import annotations

import json
import os
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from chkit_plugin_backfill import run_lock as run_lock_module
from chkit_plugin_backfill.async_backfill import BackfillInterruptedError
from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.run_lock import acquire_run_lock, run_lock_path, with_run_lock
from chkit_plugin_backfill.state import sync_directory

SRC = Path(__file__).resolve().parents[1] / "src"

PLAN_ID = "0123456789abcdef"
# The lock the TS port writes and reads too: same path, same format.
FIXTURE = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "backfill-run-lock.json"


def _runs_dir(tmp_path: Path) -> Path:
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    return runs_dir


def _dead_pid() -> int:
    """A pid on this host that no process has: one of a child that has exited."""
    child = subprocess.run(
        [sys.executable, "-c", "import os; print(os.getpid())"],
        capture_output=True,
        text=True,
        check=True,
    )
    return int(child.stdout.strip())


def _busy(lock_path: Path, by: str) -> str:
    return (
        f"Backfill plan {PLAN_ID} is locked by another run, resume or cancel ({by}). Wait "
        "for it to end. If it has ended without releasing the lock, confirm that its "
        f"process no longer runs, then delete {lock_path} and re-run."
    )


def test_a_second_run_or_resume_fails_at_once_while_the_first_holds_the_lock(
    tmp_path: Path,
) -> None:
    runs_dir = _runs_dir(tmp_path)
    lock_path = run_lock_path(runs_dir, PLAN_ID)

    first = acquire_run_lock(lock_path, PLAN_ID)
    held = json.loads(lock_path.read_text(encoding="utf-8"))

    with pytest.raises(BackfillConfigError) as raised:
        acquire_run_lock(lock_path, PLAN_ID)
    assert str(raised.value) == _busy(
        lock_path, f"pid {os.getpid()} on {socket.gethostname()}, since {held['startedAt']}"
    )
    first.release()
    second = acquire_run_lock(lock_path, PLAN_ID)
    second.release()
    assert list(runs_dir.iterdir()) == []


def test_writes_the_lock_as_one_json_line_beside_the_run_checkpoint(tmp_path: Path) -> None:
    runs_dir = _runs_dir(tmp_path)
    lock_path = run_lock_path(runs_dir, PLAN_ID)

    lock = acquire_run_lock(lock_path, PLAN_ID)
    text = lock_path.read_text(encoding="utf-8")
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    assert lock_path == runs_dir / f"{PLAN_ID}.lock"
    assert text.endswith("}\n")
    assert len(text.split("\n")) == 2
    # Compact, as JSON.stringify writes it.
    assert ": " not in text
    assert ", " not in text
    record = json.loads(text)
    assert list(record) == list(fixture)
    assert (record["pid"], record["host"]) == (os.getpid(), socket.gethostname())
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", record["startedAt"])
    assert re.fullmatch(r"[0-9a-f]{16}", record["token"])
    lock.release()


def test_refuses_a_lock_taken_on_another_host(tmp_path: Path) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    shutil.copyfile(FIXTURE, lock_path)

    with pytest.raises(BackfillConfigError) as raised:
        acquire_run_lock(lock_path, PLAN_ID)
    assert str(raised.value) == _busy(
        lock_path, "pid 4242 on chkit-lock-fixture.invalid, since 2026-11-18T10:00:00.000Z"
    )
    assert lock_path.read_text(encoding="utf-8") == FIXTURE.read_text(encoding="utf-8")


def test_refuses_a_lock_it_cannot_read(tmp_path: Path) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    lock_path.write_text("", encoding="utf-8")

    with pytest.raises(BackfillConfigError) as raised:
        acquire_run_lock(lock_path, PLAN_ID)
    assert str(raised.value) == _busy(lock_path, "its lock file cannot be read")


# Round 2: the schedule that let two contenders hold the lock. B and A both
# see a dead holder's lock; under the old takeover A removed it and took the
# lock, B moved A's lock aside, and C took the empty path. Without takeover, a
# lock is only ever removed by its holder or by the operator, so no schedule
# gives it to two contenders.
def test_never_takes_over_a_lock_even_of_a_dead_process(tmp_path: Path) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    stale = {
        "pid": _dead_pid(),
        "host": socket.gethostname(),
        "startedAt": "2026-11-18T10:00:00.000Z",
        "token": "aaaaaaaaaaaaaaaa",
    }
    lock_path.write_text(json.dumps(stale) + "\n", encoding="utf-8")
    stale_by = f"pid {stale['pid']} on {socket.gethostname()}, since {stale['startedAt']}"

    for _contender in ("B", "A"):
        with pytest.raises(BackfillConfigError) as raised:
            acquire_run_lock(lock_path, PLAN_ID)
        assert str(raised.value) == _busy(lock_path, stale_by)
    assert json.loads(lock_path.read_text(encoding="utf-8")) == stale

    lock_path.unlink()  # the operator, once the holder is confirmed dead
    a = acquire_run_lock(lock_path, PLAN_ID)
    held = json.loads(lock_path.read_text(encoding="utf-8"))
    for _contender in ("B", "C"):
        with pytest.raises(BackfillConfigError) as raised:
            acquire_run_lock(lock_path, PLAN_ID)
        assert str(raised.value) == _busy(
            lock_path, f"pid {os.getpid()} on {socket.gethostname()}, since {held['startedAt']}"
        )
    a.release()
    acquire_run_lock(lock_path, PLAN_ID).release()


def _python(script: str, *, stdin: int | None = None) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-c", script],
        stdin=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "PYTHONPATH": str(SRC)},
    )


def test_one_of_several_processes_racing_for_the_lock_gets_it(tmp_path: Path) -> None:
    runs_dir = _runs_dir(tmp_path)
    lock_path = run_lock_path(runs_dir, PLAN_ID)
    release_path = tmp_path / "release"
    script = f"""
import time
from pathlib import Path
from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.run_lock import acquire_run_lock
try:
    lock = acquire_run_lock({str(lock_path)!r}, {PLAN_ID!r})
except BackfillConfigError:
    print("busy", flush=True)
else:
    print("acquired", flush=True)
    while not Path({str(release_path)!r}).exists():
        time.sleep(0.01)
    lock.release()
"""

    children = [_python(script) for _ in range(6)]
    outcomes = []
    try:
        for child in children:
            assert child.stdout is not None
            ready, _, _ = select.select([child.stdout], [], [], 30)
            assert ready, "lock contender did not report its outcome"
            outcomes.append(child.stdout.readline().strip())
        assert sorted(outcomes) == ["acquired", "busy", "busy", "busy", "busy", "busy"]
    finally:
        release_path.touch()
        results = []
        for child in children:
            try:
                _, stderr = child.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                child.kill()
                _, stderr = child.communicate()
            results.append((child.returncode, stderr))
        for code, stderr in results:
            assert code == 0, stderr
    assert list(runs_dir.iterdir()) == []


def _lingering_body(lock_path: Path, log: Path) -> str:
    # The body stands in for a run: once stopped, it writes its last
    # checkpoint 300 ms later, recording whether it still holds the lock.
    return f"""
import os, sys, time
from chkit_plugin_backfill.run_lock import with_run_lock
def body(stop):
    print("ready", flush=True)
    stop.wait(30)
    time.sleep(0.3)
    with open({str(log)!r}, "a") as out:
        out.write("last checkpoint, lock held: " + str(os.path.exists({str(lock_path)!r})) + "\\n")
    raise RuntimeError("interrupted")
with_run_lock({str(lock_path)!r}, {PLAN_ID!r}, body)
"""


def test_with_run_lock_releases_after_the_body_and_exits_130(tmp_path: Path) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    log = tmp_path / "writes.log"
    child = _python(_lingering_body(lock_path, log))
    assert child.stdout is not None
    assert child.stdout.readline().strip() == "ready"

    child.send_signal(signal.SIGINT)
    _stdout, stderr = child.communicate(timeout=30)

    assert child.returncode == 130
    assert log.read_text(encoding="utf-8") == "last checkpoint, lock held: True\n"
    assert not lock_path.exists()
    assert (
        f"Backfill plan {PLAN_ID}: interrupted (SIGINT). No new chunk was submitted, and "
        "the lock is released"
    ) in stderr


# Opus critic, item 1: a second signal does not wait for the body, and leaves
# the lock in place, saying so.
def test_a_second_sigint_exits_at_once_and_leaves_the_lock_in_place(tmp_path: Path) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    log = tmp_path / "writes.log"
    child = _python(_lingering_body(lock_path, log))
    assert child.stdout is not None
    assert child.stdout.readline().strip() == "ready"

    child.send_signal(signal.SIGINT)
    time.sleep(0.05)
    child.send_signal(signal.SIGINT)
    _stdout, stderr = child.communicate(timeout=30)

    assert child.returncode == 130
    assert not log.exists()
    assert lock_path.exists()
    assert (
        f"Backfill plan {PLAN_ID}: SIGINT again, exiting at once. The lock {lock_path} stays "
        "in place: a chunk being sent may still reach the server, and its attempt stays "
        "recorded as one that may have run. Once this process has exited, delete the lock "
        "and re-run."
    ) in stderr


def test_a_body_that_says_a_request_may_still_be_sent_keeps_the_lock(tmp_path: Path) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)

    def body(_stop: object) -> None:
        raise BackfillInterruptedError("interrupted.", note="still sending.", keep_lock=True)

    with pytest.raises(BackfillInterruptedError, match=r"interrupted\. still sending\."):
        with_run_lock(lock_path, PLAN_ID, body)

    assert lock_path.exists()


# Round 3 item 5: runs/ made by another process that never synced its parent.
def test_syncs_the_state_directory_and_its_parent_even_when_runs_already_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runs_dir = _runs_dir(tmp_path)
    synced: list[int] = []
    real_fsync = os.fsync

    def record_sync(fd: int) -> None:
        synced.append(os.fstat(fd).st_ino)
        real_fsync(fd)

    monkeypatch.setattr("chkit_plugin_backfill.state.os.fsync", record_sync)

    acquire_run_lock(run_lock_path(runs_dir, PLAN_ID), PLAN_ID).release()

    assert tmp_path.stat().st_ino in synced
    assert tmp_path.parent.stat().st_ino in synced
    assert runs_dir.stat().st_ino in synced


# Round 3 item 6: the lock is owned from the link on.
def test_a_failure_after_the_lock_is_linked_removes_it_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runs_dir = _runs_dir(tmp_path)
    lock_path = run_lock_path(runs_dir, PLAN_ID)
    calls: list[Path] = []

    def failing_sync(directory: Path) -> None:
        calls.append(directory)
        # The first sync of runs/ after the link fails; the removal's succeeds.
        if directory == runs_dir and lock_path.exists() and calls.count(runs_dir) == 1:
            msg = "EIO: i/o error, fsync"
            raise OSError(msg)
        sync_directory(directory)

    monkeypatch.setattr(run_lock_module, "sync_directory", failing_sync)

    with pytest.raises(RuntimeError) as raised:
        acquire_run_lock(lock_path, PLAN_ID)

    assert str(raised.value) == (
        f"Backfill plan {PLAN_ID}: could not take its lock (EIO: i/o error, fsync); the lock "
        f"file {lock_path} was removed."
    )
    assert list(runs_dir.iterdir()) == []


def _wait_for(child: subprocess.Popen[str], line: str) -> None:
    assert child.stdout is not None
    assert child.stdout.readline().strip() == line


# Round 3 item 4: SIGINT while the main thread waits between reconcile reads.
# A handler that set a threading.Event could deadlock inside that wait.
def test_sigint_while_a_resume_waits_between_reads_releases_the_lock_and_exits_130(
    tmp_path: Path,
) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    script = f"""
from chkit_plugin_backfill.async_backfill import execute_backfill
from chkit_plugin_backfill.run_lock import with_run_lock
from chkit_plugin_backfill.types import BackfillChunkState

class Result:
    def __init__(self, rows):
        self.rows = rows

class Empty:
    def __init__(self):
        self.reads = 0
    def query(self, statement):
        if "system.one" in statement:
            return Result([{{"replicas": 1}}])
        if "system.query_log" in statement:
            self.reads += 1
            if self.reads == 1:
                print("waiting", flush=True)
        return Result([])
    def submit(self, statement, query_id=None):
        raise AssertionError("submitted")
    transport_admission = True
    def submit_once(self, statement, query_id):
        raise AssertionError("submitted")

with_run_lock({str(lock_path)!r}, {PLAN_ID!r}, lambda stop: execute_backfill(
    executor=Empty(), plan_id={PLAN_ID!r}, chunk_ids=["c1"], build_query=lambda _c: "SELECT 1",
    resume_from={{"c1": BackfillChunkState(status="pending", query_id="q", single_send=True)}},
    checkpoint_version=2, outcome_recheck_attempts=5, outcome_recheck_interval_ms=30000, stop=stop,
))
"""
    child = _python(script)
    _wait_for(child, "waiting")
    time.sleep(0.2)

    child.send_signal(signal.SIGINT)
    _stdout, stderr = child.communicate(timeout=20)

    assert child.returncode == 130
    assert not lock_path.exists()
    assert f"Backfill plan {PLAN_ID}: interrupted (SIGINT). No new chunk was submitted, and the lock is released" in stderr


# Round 3 item 9: SIGTERM while a resume's read hangs.
def test_sigterm_during_a_hung_resume_read_releases_the_lock_and_exits_143(tmp_path: Path) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    script = f"""
import threading
from chkit_plugin_backfill.async_backfill import execute_backfill
from chkit_plugin_backfill.run_lock import with_run_lock
from chkit_plugin_backfill.types import BackfillChunkState

class Hung:
    def query(self, statement):
        print("reading", flush=True)
        threading.Event().wait(60)
    def submit(self, statement, query_id=None):
        raise AssertionError("submitted")
    transport_admission = True
    def submit_once(self, statement, query_id):
        raise AssertionError("submitted")

with_run_lock({str(lock_path)!r}, {PLAN_ID!r}, lambda stop: execute_backfill(
    executor=Hung(), plan_id={PLAN_ID!r}, chunk_ids=["c1"], build_query=lambda _c: "SELECT 1",
    resume_from={{"c1": BackfillChunkState(status="pending")}}, stop=stop,
))
"""
    child = _python(script)
    _wait_for(child, "reading")

    child.send_signal(signal.SIGTERM)
    _stdout, stderr = child.communicate(timeout=20)

    assert child.returncode == 143
    assert not lock_path.exists()
    assert f"Backfill plan {PLAN_ID}: interrupted (SIGTERM). No new chunk was submitted, and the lock is released" in stderr


# Round 3 item 7: cancel uses the signal-aware wrapper, with its own message.
def test_a_cancel_interrupted_under_the_lock_releases_it_with_its_own_message(tmp_path: Path) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    script = f"""
from chkit_plugin_backfill.run_lock import with_run_lock
def body(stop):
    print("ready", flush=True)
    stop.wait(30)
with_run_lock({str(lock_path)!r}, {PLAN_ID!r}, body, command="cancel")
"""
    child = _python(script)
    _wait_for(child, "ready")

    child.send_signal(signal.SIGINT)
    _stdout, stderr = child.communicate(timeout=20)

    assert child.returncode == 130
    assert not lock_path.exists()
    assert f"Backfill plan {PLAN_ID}: cancel interrupted (SIGINT); the lock is released." in stderr


def test_a_second_sigint_during_a_cancel_leaves_the_lock_with_the_cancel_message(
    tmp_path: Path,
) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    # The cancel's body keeps going after the first SIGINT.
    script = f"""
import time
from chkit_plugin_backfill.run_lock import with_run_lock
def body(stop):
    print("ready", flush=True)
    stop.wait(30)
    time.sleep(30)
with_run_lock({str(lock_path)!r}, {PLAN_ID!r}, body, command="cancel")
"""
    child = _python(script)
    _wait_for(child, "ready")

    child.send_signal(signal.SIGINT)
    time.sleep(0.05)
    child.send_signal(signal.SIGINT)
    _stdout, stderr = child.communicate(timeout=20)

    assert child.returncode == 130
    assert lock_path.exists()
    assert (
        f"Backfill plan {PLAN_ID}: SIGINT again, exiting at once. The lock {lock_path} stays "
        "in place. Once this process has exited, delete the lock and re-run."
    ) in stderr
    assert "a chunk being sent" not in stderr



# #765 whole-branch review: a second SIGINT on the way to the forced exit is
# caught too; it never raises KeyboardInterrupt into a wait for an INSERT.
def test_a_second_sigint_during_the_forced_exit_changes_nothing(tmp_path: Path) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    script = f"""
import sys, threading, time
from chkit_plugin_backfill.run_lock import with_run_lock

class SlowStderr:
    def __init__(self, inner):
        self.inner = inner
    def write(self, text):
        if "interrupted" in text:
            print("exiting", flush=True)
            time.sleep(0.5)  # the second SIGINT lands here
        return self.inner.write(text)
    def flush(self):
        self.inner.flush()

sys.stderr = SlowStderr(sys.stderr)
insert_done = threading.Event()

def body(stop):
    print("ready", flush=True)
    stop.wait(30)

with_run_lock({str(lock_path)!r}, {PLAN_ID!r}, body)
insert_done.wait(30)  # stands in for an INSERT the exit must not wait for
"""
    child = _python(script)
    _wait_for(child, "ready")

    child.send_signal(signal.SIGINT)
    _wait_for(child, "exiting")
    child.send_signal(signal.SIGINT)
    started = time.monotonic()
    _stdout, stderr = child.communicate(timeout=20)

    assert child.returncode == 130
    assert time.monotonic() - started < 5
    assert "KeyboardInterrupt" not in stderr
    assert not lock_path.exists()
