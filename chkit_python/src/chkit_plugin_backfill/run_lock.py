"""The lock a backfill ``run`` or ``resume`` holds on its plan (#765).

Port of ``packages/plugin-backfill/src/run-lock.ts``: same path
(``<stateDir>/runs/<planId>.lock``) and format (one JSON line of pid, host,
startedAt and token), so a TS and a Python run of one plan exclude each other.
It is held from before the checkpoint is read until the run ends, so two runs
or resumes never submit the same chunk under two query ids.
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import socket
from dataclasses import dataclass
from pathlib import Path

from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.state import now_iso, sync_directory, write_file_durably


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
        if isinstance(holder, RunLockRecord) and holder.token == self.token:
            self.path.unlink()


def run_lock_path(runs_dir: str | Path, plan_id: str) -> Path:
    """``<stateDir>/runs/<planId>.lock``, beside the run checkpoint."""
    return Path(runs_dir) / f"{plan_id}.lock"


def acquire_run_lock(lock_path: str | Path, plan_id: str) -> RunLock:
    """Take the plan's lock, or fail at once when another run or resume holds it.

    A lock is taken over only when its process is provably dead: it was taken
    on this host, by another pid, and no process has that pid. Any other lock,
    including one that cannot be read, stays, and the error says how to clear it.
    """
    path = Path(lock_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = RunLockRecord(
        pid=os.getpid(),
        host=socket.gethostname(),
        started_at=now_iso(),
        token=secrets.token_hex(8),
    )
    # Two tries: the second follows the removal of a dead process's lock.
    for _ in range(2):
        if _create_lock_file(path, record):
            return RunLock(path=path, token=record.token)
        holder = _read_lock_record(path)
        if holder == "missing":
            continue
        if not isinstance(holder, RunLockRecord):
            raise _lock_busy_error(plan_id, path, None)
        if not _is_provably_dead(holder):
            raise _lock_busy_error(plan_id, path, holder)
        _remove_stale_lock(path, holder, record.token, plan_id)
    raise _lock_busy_error(plan_id, path, None)


def _create_lock_file(path: Path, record: RunLockRecord) -> bool:
    """Create the lock file with its whole content, or return False when it exists."""
    # Written in full beside the lock, then linked: a link fails when the lock
    # exists, and no reader ever sees a half-written lock.
    tmp_path = path.with_name(f"{path.name}.{record.token}.tmp")
    write_file_durably(tmp_path, record.to_json() + "\n")
    try:
        os.link(tmp_path, path)
    except FileExistsError:
        return False
    finally:
        tmp_path.unlink()
    sync_directory(path.parent)
    return True


def _read_lock_record(path: Path) -> RunLockRecord | str:
    """The lock's record, ``"missing"`` or ``"unreadable"``."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "missing"
    try:
        parsed = json.loads(text)
    except ValueError:
        return "unreadable"
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
    return "unreadable"


def _is_provably_dead(holder: RunLockRecord) -> bool:
    """Whether the lock's process is dead for sure. Another host's process,
    this process's own pid (another run in this process may hold it), and
    Windows (where ``os.kill`` would terminate the process) are never
    provably dead."""
    if holder.host != socket.gethostname() or holder.pid == os.getpid() or os.name == "nt":
        return False
    try:
        os.kill(holder.pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    return False


def _remove_stale_lock(path: Path, holder: RunLockRecord, token: str, plan_id: str) -> None:
    """Move the dead process's lock aside and check that it is the lock judged
    dead: another resume may have replaced it meanwhile. That one is put back."""
    moved_path = path.with_name(f"{path.name}.{token}.stale")
    try:
        path.rename(moved_path)
    except FileNotFoundError:
        return
    moved = _read_lock_record(moved_path)
    if isinstance(moved, RunLockRecord) and moved.token == holder.token:
        moved_path.unlink()
        return
    with contextlib.suppress(FileExistsError):
        os.link(moved_path, path)
    moved_path.unlink()
    raise _lock_busy_error(plan_id, path, moved if isinstance(moved, RunLockRecord) else None)


def _lock_busy_error(
    plan_id: str, path: Path, holder: RunLockRecord | None
) -> BackfillConfigError:
    if holder is None:
        return BackfillConfigError(
            f"Backfill plan {plan_id} is locked by another run or resume (lock file "
            f"{path} cannot be read). If no run or resume of this plan is running, "
            "delete that file and re-run."
        )
    return BackfillConfigError(
        f"Backfill plan {plan_id} is locked by another run or resume (pid "
        f"{holder.pid} on {holder.host}, since {holder.started_at}). Wait for it to "
        f"end. If that process is no longer running, delete {path} and re-run."
    )


__all__ = ["RunLock", "RunLockRecord", "acquire_run_lock", "run_lock_path"]
