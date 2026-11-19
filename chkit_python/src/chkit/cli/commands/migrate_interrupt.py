"""Ctrl-C on migrate, as in TS (``packages/cli/src/commands/migrate/interrupt.ts``, #816).

A first SIGINT stops the run with ``KeyboardInterrupt``. While a sync statement
runs (``deferred_interrupt``), it is deferred: the statement finishes and its
outcome is recorded first; a request not sent yet is refused
(``raise_if_interrupted``). Once the run has ended, its migrate lock released,
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
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from types import FrameType
from typing import TypeVar

from chkit.cli.commands.migrate_lock import LOCK_TIMINGS

INTERRUPT_WAIT_SECONDS = 30.0

_T = TypeVar("_T")


class MigrateInterrupted(Exception):  # noqa: N818 - named as the TS abort reason
    """A request refused, unsent, after a first SIGINT; recorded like a failure."""

    def __init__(self) -> None:
        super().__init__("The run was interrupted (SIGINT).")


@dataclass
class InterruptLock:
    """The migrate lock as the interrupted run reports it; ``with_lock`` keeps it current."""

    claim: str | None = None
    released: bool = False


class _State:
    depth = 0
    received = False
    pending = False
    deferring = 0


_state = _State()


def raise_if_interrupted() -> None:
    """Refuses a request not sent yet once a first SIGINT came."""
    if _state.received:
        raise MigrateInterrupted


@contextmanager
def deferred_interrupt() -> Iterator[None]:
    """A first SIGINT waits for this block (a sync statement and its record)."""
    _state.deferring += 1
    error: Exception | None = None
    stopped = False
    try:
        yield
    except Exception as raised:
        error = raised
        raise
    except BaseException:
        stopped = True
        raise
    finally:
        _state.deferring -= 1
        if _state.pending and _state.deferring == 0 and not stopped:
            _state.pending = False
            raise KeyboardInterrupt from error


@contextmanager
def interruptible() -> Iterator[None]:
    """Inside a deferred block, a step a SIGINT stops at once (a barrier's polls)."""
    saved = _state.deferring
    try:
        _state.deferring = 0
        # Also a SIGINT that came while deferral was still on.
        raise_if_interrupted()
        yield
    except KeyboardInterrupt as error:
        _state.pending = True
        raise MigrateInterrupted from error
    finally:
        _state.deferring = saved


def with_interrupt(lock: InterruptLock, body: Callable[[], _T]) -> _T:
    """Runs ``body`` with the SIGINT handler (main thread, outermost call only)."""
    if _state.depth > 0 or threading.current_thread() is not threading.main_thread():
        return body()
    timer: threading.Timer | None = None
    exit_lock = threading.RLock()
    done = False

    def exit_now(why: str) -> None:
        with exit_lock:
            if done:
                return
        message = f"migrate: {why}, exiting at once. {_lock_line(lock, exiting_now=True)}\n"
        # A blocked or closed stderr never keeps the process alive.
        writer = threading.Thread(target=_write_stderr, args=(message,), daemon=True)
        writer.start()
        writer.join(timeout=1.0)
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
    _state.depth += 1
    stop_error: BaseException | None = None
    try:
        return body()
    except BaseException as error:
        stop_error = error
        if _state.received and not isinstance(error, KeyboardInterrupt):
            raise KeyboardInterrupt from error
        raise
    finally:
        _state.depth -= 1
        signal.signal(signal.SIGINT, previous)
        with exit_lock:
            done = True
        if timer is not None:
            timer.cancel()
        if _state.received:
            _state.received = False
            _state.pending = False
            detail = _detail(stop_error)
            with suppress(BaseException):
                sys.stderr.write(
                    "migrate: interrupted (SIGINT). No new statement was started. "
                    f"{_lock_line(lock, exiting_now=False)}{detail}\n"
                )
                sys.stderr.flush()


def _write_stderr(message: str) -> None:
    with suppress(BaseException):
        sys.stderr.write(message)
        sys.stderr.flush()


def _detail(error: BaseException | None) -> str:
    """A stop's own error, as TS prints it; not the interrupt itself."""
    cause = error.__cause__ if isinstance(error, KeyboardInterrupt) else error
    seen = cause
    while seen is not None:
        if isinstance(seen, (KeyboardInterrupt, MigrateInterrupted)):
            return ""
        seen = seen.__cause__
    return f"\n{cause}" if cause is not None else ""


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
