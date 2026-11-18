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
    """Take the plan's lock, or fail at once when it exists."""
    path = Path(lock_path)
    mkdir_durably(path.parent)
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
        raise _lock_busy_error(plan_id, path, _read_lock_record(path)) from None
    finally:
        tmp_path.unlink()
    sync_directory(path.parent)
    return RunLock(path=path, token=record.token)


_EXIT_CODES = {signal.SIGINT: 130, signal.SIGTERM: 143}


def with_run_lock(
    lock_path: str | Path, plan_id: str, body: Callable[[threading.Event], T]
) -> T:
    """Run ``body`` holding the plan's lock. A SIGINT or SIGTERM sets the event
    ``body`` gets (instead of raising KeyboardInterrupt); once ``body``
    returns or raises, the lock is released and the process exits with
    128 + the signal's number. Later signals do nothing, so the lock is never
    released while a worker can still write the checkpoint. Signals are only
    caught on the main thread, where Python delivers them."""
    stop = threading.Event()
    received: list[int] = []

    def on_signal(signum: int, _frame: FrameType | None) -> None:
        if not received:
            received.append(signum)
            stop.set()

    previous: dict[signal.Signals, Any] = {}
    if threading.current_thread() is threading.main_thread():
        for caught in _EXIT_CODES:
            previous[caught] = signal.signal(caught, on_signal)
    try:
        lock = acquire_run_lock(lock_path, plan_id)
        try:
            return body(stop)
        finally:
            lock.release()
    finally:
        for caught, handler in previous.items():
            signal.signal(caught, handler)
        if received:
            name = signal.Signals(received[0]).name
            sys.stderr.write(
                f"Backfill plan {plan_id}: interrupted ({name}). No new chunk was "
                "submitted, and the lock is released; a chunk already submitted keeps "
                "running on the server, and a resume attaches to it.\n"
            )
            sys.stdout.flush()
            sys.stderr.flush()
            # Chunks in flight still block in their submit; they report
            # nothing now, and the process must not wait for their INSERT.
            os._exit(_EXIT_CODES[signal.Signals(received[0])])


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


__all__ = ["RunLock", "RunLockRecord", "acquire_run_lock", "run_lock_path", "with_run_lock"]
