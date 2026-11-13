"""Absolute wall-clock limits for migration cancellation control requests."""

from __future__ import annotations

import math
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from typing import TypeVar

STRICT_CONTROL_SETTINGS: dict[str, str | int] = {
    "use_query_cache": 0,
    "enable_reads_from_query_cache": 0,
    "enable_writes_to_query_cache": 0,
    "read_overflow_mode": "throw",
    "read_overflow_mode_leaf": "throw",
    "group_by_overflow_mode": "throw",
    "sort_overflow_mode": "throw",
    "result_overflow_mode": "throw",
    "timeout_overflow_mode": "throw",
    "timeout_overflow_mode_leaf": "throw",
    "set_overflow_mode": "throw",
    "transfer_overflow_mode": "throw",
    "distinct_overflow_mode": "throw",
}

_T = TypeVar("_T")


def run_control_request(request: Callable[[float], _T], timeout_ms: float) -> _T:
    """Bound connection, headers and body together; a late worker never blocks exit.

    The callback receives its absolute monotonic deadline. Cancellation callers
    must stop on expiry; a late request only names immutable old query ids.
    """
    if not math.isfinite(timeout_ms) or timeout_ms <= 0:
        raise TimeoutError("Cancellation deadline expired")
    deadline = time.monotonic() + timeout_ms / 1000
    remaining_control_seconds(deadline)
    result: Future[_T] = Future()

    def run() -> None:
        try:
            remaining_control_seconds(deadline)
            value = request(deadline)
            remaining_control_seconds(deadline)
            result.set_result(value)
        except BaseException as error:
            result.set_exception(error)

    threading.Thread(target=run, name="chkit-cancellation-control", daemon=True).start()
    try:
        return result.result(timeout=remaining_control_seconds(deadline))
    except TimeoutError as error:
        raise TimeoutError("Cancellation deadline expired") from error


def remaining_control_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Cancellation deadline expired")
    return remaining
