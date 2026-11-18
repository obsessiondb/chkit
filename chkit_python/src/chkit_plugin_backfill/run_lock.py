"""The lock a backfill ``run``, ``resume`` or ``cancel`` holds on its plan (#765).

Port of ``packages/plugin-backfill/src/run-lock.ts``: same path
(``<stateDir>/runs/<planId>.lock``) and format (one JSON line of pid, host,
startedAt and token), so a TS and a Python run of one plan exclude each other.
It is held from before the checkpoint is read until the command ends, so two
of them never write the checkpoint or submit the same chunk under two query
ids.

A lock that exists always blocks: no process takes another's lock over, since
no pid or host check proves a holder dead across PID namespaces, containers or
a reused pid. A holder releases it when it ends, also on SIGINT or SIGTERM
(see ``with_run_lock``); after a crash the operator deletes it.
"""

from __future__ import annotations

import json
import os
import secrets
import signal
import socket
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import FrameType
from typing import Any, TypeVar

from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.state import (
    mkdir_durably,
    now_iso,
    sync_directory,
    write_file_durably,
)

T = TypeVar("T")


@dataclass(frozen=True)
class RunLockRecord:
    pid: int
    host: str
    started_at: str
    token: str

    def to_json(self) -> str:
        return json.dumps(
            {"pid": self.pid, "host": self.host, "startedAt": self.started_at, "token": self.token},
            separators=(",", ":"),
        )


@dataclass(frozen=True)
class RunLock:
    path: Path
    token: str

    def release(self) -> None:
        holder = _read_lock_record(self.path)
        if holder is None or holder.token != self.token:
            return
        self.path.unlink()
        sync_directory(self.path.parent)


def run_lock_path(runs_dir: str | Path, plan_id: str) -> Path:
    """``<stateDir>/runs/<planId>.lock``, beside the run checkpoint."""
    return Path(runs_dir) / f"{plan_id}.lock"


def acquire_run_lock(lock_path: str | Path, plan_id: str) -> RunLock:
    """Take the plan's lock, or fail at once when it exists. Before that, every
    directory entry on the way to the checkpoint is synced: ``runs/`` and the
    state directory, also when another process created them, so a power loss
    after a send cannot drop the checkpoint that names it (#765)."""
    path = Path(lock_path)
    runs_dir = path.parent
    mkdir_durably(runs_dir)
    sync_directory(runs_dir.parent)
    sync_directory(runs_dir.parent.parent)
    record = RunLockRecord(
        pid=os.getpid(),
        host=socket.gethostname(),
        started_at=now_iso(),
        token=secrets.token_hex(8),
    )
    # Written in full beside the lock, then linked: a link fails when the lock
    # exists, so one contender wins, and no reader sees a half-written lock.
    tmp_path = path.with_name(f"{path.name}.{record.token}.tmp")
    write_file_durably(tmp_path, record.to_json() + "\n")
    try:
        os.link(tmp_path, path)
    except FileExistsError:
        tmp_path.unlink(missing_ok=True)
        raise _lock_busy_error(plan_id, path, _read_lock_record(path)) from None
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    # Owned from the link on: a later failure removes the lock, by its token,
    # and says whether that worked.
    lock = RunLock(path=path, token=record.token)
    try:
        tmp_path.unlink()
        sync_directory(runs_dir)
    except Exception as error:
        try:
            lock.release()
            removal = "was removed"
        except Exception as remove_error:
            removal = (
                f"could not be removed ({remove_error}): delete it once no run, resume "
                "or cancel of this plan runs"
            )
        msg = (
            f"Backfill plan {plan_id}: could not take its lock ({error}); the lock "
            f"file {path} {removal}."
        )
        raise RuntimeError(msg) from error
    return lock


_EXIT_CODES = {signal.SIGINT: 130, signal.SIGTERM: 143}


class StopFlag:
    """Set from a signal handler. Recording a signal is a plain list append,
    which takes no lock: a handler that set a ``threading.Event`` could
    deadlock on the lock of an ``Event.wait`` the main thread is inside."""

    def __init__(self) -> None:
        self._signals: list[int] = []

    def record(self, signum: int) -> None:
        self._signals.append(signum)

    @property
    def signum(self) -> int | None:
        return self._signals[0] if self._signals else None

    def is_set(self) -> bool:
        return bool(self._signals)

    def wait(self, timeout: float | None = None) -> bool:
        deadline = None if timeout is None else time.monotonic() + timeout
        while not self.is_set():
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                return False
            time.sleep(0.05 if remaining is None else min(0.05, remaining))
        return True


def with_run_lock(
    lock_path: str | Path,
    plan_id: str,
    body: Callable[[StopFlag], T],
    *,
    command: str = "run",
) -> T:
    """Run ``body`` holding the plan's lock. A SIGINT or SIGTERM sets the flag
    ``body`` gets (instead of raising KeyboardInterrupt); once ``body``
    returns or raises, the lock is released and the process exits with
    128 + the signal's number, saying whether the lock was removed. Later
    signals do nothing, so the lock is never released while a worker can
    still write the checkpoint or send a chunk. Signals are only caught on
    the main thread, where Python delivers them."""
    stop = StopFlag()

    def on_signal(signum: int, _frame: FrameType | None) -> None:
        stop.record(signum)

    previous: dict[signal.Signals, Any] = {}
    if threading.current_thread() is threading.main_thread():
        for caught in _EXIT_CODES:
            previous[caught] = signal.signal(caught, on_signal)
    released: str | None = None
    try:
        lock = acquire_run_lock(lock_path, plan_id)
        try:
            result = body(stop)
        finally:
            try:
                lock.release()
                released = "released"
            except Exception as error:
                released = (
                    f"could not be removed ({error}): delete {lock.path} once no run, "
                    "resume or cancel of this plan runs"
                )
        if released != "released" and not stop.is_set():
            msg = f"Backfill plan {plan_id}: the lock {released}."
            raise RuntimeError(msg)
        return result
    finally:
        signum = stop.signum
        # On the way to the forced exit the handlers stay installed: a second
        # signal must not raise KeyboardInterrupt and wait for an INSERT.
        if signum is None:
            for caught, handler in previous.items():
                signal.signal(caught, handler)
        if signum is not None:
            name = signal.Signals(signum).name
            sys.stderr.write(_interrupt_message(plan_id, name, command, released) + "\n")
            sys.stdout.flush()
            sys.stderr.flush()
            # Chunks in flight still block in their submit; they report
            # nothing now, and the process must not wait for their INSERT.
            os._exit(_EXIT_CODES[signal.Signals(signum)])


def _interrupt_message(plan_id: str, name: str, command: str, released: str | None) -> str:
    if released is None:
        lock = "the lock was not taken"
    elif released == "released":
        lock = "the lock is released"
    else:
        lock = f"the lock {released}"
    if command == "cancel":
        return f"Backfill plan {plan_id}: cancel interrupted ({name}); {lock}."
    return (
        f"Backfill plan {plan_id}: interrupted ({name}). No new chunk was submitted, "
        f"and {lock}; a chunk already submitted keeps running on the server, and a "
        "resume attaches to it."
    )


def _read_lock_record(path: Path) -> RunLockRecord | None:
    """The lock's record, or None when it is missing or cannot be read."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    if (
        isinstance(parsed, dict)
        and isinstance(parsed.get("pid"), int)
        and not isinstance(parsed.get("pid"), bool)
        and isinstance(parsed.get("host"), str)
        and isinstance(parsed.get("startedAt"), str)
        and isinstance(parsed.get("token"), str)
    ):
        return RunLockRecord(
            pid=parsed["pid"],
            host=parsed["host"],
            started_at=parsed["startedAt"],
            token=parsed["token"],
        )
    return None


def _lock_busy_error(
    plan_id: str, path: Path, holder: RunLockRecord | None
) -> BackfillConfigError:
    by = (
        f"pid {holder.pid} on {holder.host}, since {holder.started_at}"
        if holder is not None
        else "its lock file cannot be read"
    )
    return BackfillConfigError(
        f"Backfill plan {plan_id} is locked by another run, resume or cancel ({by}). "
        "Wait for it to end. If it has ended without releasing the lock, confirm "
        f"that its process no longer runs, then delete {path} and re-run."
    )


__all__ = [
    "RunLock",
    "RunLockRecord",
    "StopFlag",
    "acquire_run_lock",
    "run_lock_path",
    "with_run_lock",
]
