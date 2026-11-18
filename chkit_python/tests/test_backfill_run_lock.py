"""Port of ``packages/plugin-backfill/src/run-lock.test.ts`` (#765)."""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.run_lock import acquire_run_lock, run_lock_path

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


def _python(script: str) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-c", script],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "PYTHONPATH": str(SRC)},
    )


def test_one_of_several_processes_racing_for_the_lock_gets_it(tmp_path: Path) -> None:
    runs_dir = _runs_dir(tmp_path)
    lock_path = run_lock_path(runs_dir, PLAN_ID)
    script = f"""
import time
from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.run_lock import acquire_run_lock
try:
    lock = acquire_run_lock({str(lock_path)!r}, {PLAN_ID!r})
except BackfillConfigError:
    print("busy")
else:
    print("acquired")
    time.sleep(1)
    lock.release()
"""

    children = [_python(script) for _ in range(6)]
    outcomes = sorted(child.communicate(timeout=30)[0].strip() for child in children)

    assert outcomes == ["acquired", "busy", "busy", "busy", "busy", "busy"]
    assert list(runs_dir.iterdir()) == []


def test_with_run_lock_releases_after_the_body_ignores_a_second_sigint_and_exits_130(
    tmp_path: Path,
) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    log = tmp_path / "writes.log"
    # The body stands in for a run: once stopped, it writes its last
    # checkpoint 300 ms later, recording whether it still holds the lock.
    script = f"""
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
    child = _python(script)
    assert child.stdout is not None
    assert child.stdout.readline().strip() == "ready"

    child.send_signal(signal.SIGINT)
    time.sleep(0.05)
    child.send_signal(signal.SIGINT)
    _stdout, stderr = child.communicate(timeout=30)

    assert child.returncode == 130
    assert log.read_text(encoding="utf-8") == "last checkpoint, lock held: True\n"
    assert not lock_path.exists()
    assert (
        f"Backfill plan {PLAN_ID}: interrupted (SIGINT). No new chunk was submitted, and "
        "the lock is released"
    ) in stderr
