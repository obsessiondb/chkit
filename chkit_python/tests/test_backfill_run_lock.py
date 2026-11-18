"""Port of ``packages/plugin-backfill/src/run-lock.test.ts`` (#765)."""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.run_lock import acquire_run_lock, run_lock_path

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


def test_a_second_run_or_resume_fails_at_once_while_the_first_holds_the_lock(
    tmp_path: Path,
) -> None:
    runs_dir = _runs_dir(tmp_path)
    lock_path = run_lock_path(runs_dir, PLAN_ID)

    first = acquire_run_lock(lock_path, PLAN_ID)
    held = json.loads(lock_path.read_text(encoding="utf-8"))

    with pytest.raises(BackfillConfigError) as raised:
        acquire_run_lock(lock_path, PLAN_ID)
    assert str(raised.value) == (
        f"Backfill plan {PLAN_ID} is locked by another run or resume (pid {os.getpid()} "
        f"on {socket.gethostname()}, since {held['startedAt']}). Wait for it to end. If "
        f"that process is no longer running, delete {lock_path} and re-run."
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
    assert str(raised.value) == (
        f"Backfill plan {PLAN_ID} is locked by another run or resume (pid 4242 on "
        "chkit-lock-fixture.invalid, since 2026-11-18T10:00:00.000Z). Wait for it to end. "
        f"If that process is no longer running, delete {lock_path} and re-run."
    )
    assert lock_path.read_text(encoding="utf-8") == FIXTURE.read_text(encoding="utf-8")


def test_refuses_a_lock_it_cannot_read(tmp_path: Path) -> None:
    lock_path = run_lock_path(_runs_dir(tmp_path), PLAN_ID)
    lock_path.write_text("", encoding="utf-8")

    with pytest.raises(BackfillConfigError) as raised:
        acquire_run_lock(lock_path, PLAN_ID)
    assert str(raised.value) == (
        f"Backfill plan {PLAN_ID} is locked by another run or resume (lock file "
        f"{lock_path} cannot be read). If no run or resume of this plan is running, "
        "delete that file and re-run."
    )


def test_takes_over_the_lock_of_a_process_on_this_host_that_no_longer_runs(
    tmp_path: Path,
) -> None:
    runs_dir = _runs_dir(tmp_path)
    lock_path = run_lock_path(runs_dir, PLAN_ID)
    stale = {
        "pid": _dead_pid(),
        "host": socket.gethostname(),
        "startedAt": "2026-11-18T10:00:00.000Z",
        "token": "aaaaaaaaaaaaaaaa",
    }
    lock_path.write_text(json.dumps(stale) + "\n", encoding="utf-8")

    lock = acquire_run_lock(lock_path, PLAN_ID)

    assert json.loads(lock_path.read_text(encoding="utf-8"))["pid"] == os.getpid()
    lock.release()
    assert list(runs_dir.iterdir()) == []
