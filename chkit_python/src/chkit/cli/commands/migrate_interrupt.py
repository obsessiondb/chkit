"""Ctrl-C on migrate, as in TS (``packages/cli/src/commands/migrate/interrupt.ts``, #816).

A first SIGINT stops the run with ``KeyboardInterrupt``. While a sync statement
runs (``deferred_interrupt``), it is deferred: the statement finishes and its
outcome is recorded first. Once the run has ended, its migrate lock released,
the process exits with 130. When the run does not end within
``INTERRUPT_WAIT_SECONDS``, or on a second SIGINT, it exits at once and the lock
claim stays in place: a request of the run may still be in flight.
"""

from __future__ import annotations

import os
import signal
import sys
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from types import FrameType
from typing import TypeVar

from chkit.cli.commands.migrate_lock import LOCK_TIMINGS

INTERRUPT_WAIT_SECONDS = 30.0

_T = TypeVar("_T")


@dataclass
class InterruptLock:
    """The migrate lock as the interrupted run reports it; ``with_lock`` keeps it current."""

    claim: str | None = None
    released: bool = False


class _State:
    received = False
    pending = False
    deferring = 0


_state = _State()


@contextmanager
def deferred_interrupt() -> Iterator[None]:
    """A first SIGINT waits for this block (a sync statement and its record)."""
    _state.deferring += 1
    try:
        yield
    finally:
        _state.deferring -= 1
        if _state.pending and _state.deferring == 0:
            _state.pending = False
            raise KeyboardInterrupt


def with_interrupt(lock: InterruptLock, body: Callable[[], _T]) -> _T:
    """Runs ``body`` with the SIGINT handler (main thread only)."""
    if threading.current_thread() is not threading.main_thread():
        return body()
    timer: threading.Timer | None = None

    def exit_now(why: str) -> None:
        sys.stderr.write(f"migrate: {why}, exiting at once. {_lock_line(lock, exiting_now=True)}\n")
        sys.stderr.flush()
        os._exit(130)

    def on_signal(_signum: int, _frame: FrameType | None) -> None:
        nonlocal timer
        if _state.received:
            exit_now("SIGINT again")
        _state.received = True
        timer = threading.Timer(
            INTERRUPT_WAIT_SECONDS,
            exit_now,
            (f"the run did not stop within {INTERRUPT_WAIT_SECONDS:g}s of SIGINT",),
        )
        timer.daemon = True
        timer.start()
        if _state.deferring > 0:
            _state.pending = True
            return
        raise KeyboardInterrupt

    previous = signal.signal(signal.SIGINT, on_signal)
    try:
        return body()
    finally:
        signal.signal(signal.SIGINT, previous)
        if timer is not None:
            timer.cancel()
        if _state.received:
            _state.received = False
            _state.pending = False
            sys.stderr.write(
                "migrate: interrupted (SIGINT). No new statement was started. "
                f"{_lock_line(lock, exiting_now=False)}\n"
            )
            sys.stderr.flush()


def _lock_line(lock: InterruptLock, *, exiting_now: bool) -> str:
    if lock.claim is None:
        return "This run held no migrate lock."
    if lock.released:
        return "The migrate lock is released."
    if not exiting_now:
        return f"The migrate lock claim {lock.claim} could not be released."
    return (
        f"The migrate lock claim {lock.claim} stays in place, since a request of this run "
        f"may still be in flight: other runs can take the lock "
        f"{LOCK_TIMINGS.lease_ms / 1000:g}s after its last heartbeat, or, once this process "
        f"has exited, with chkit migrate --apply --break-lock {lock.claim}."
    )
