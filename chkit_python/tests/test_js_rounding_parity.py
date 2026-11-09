"""Rounding that TS does with ``Math.round`` / ``toFixed`` rounds a .5 tie up.

Python's ``round()`` and ``f"{x:.1f}"`` round a tie to even, so without
``chkit.core.jsnum`` the two CLIs print different numbers for the same input.
"""

from __future__ import annotations

import pytest

from chkit.clickhouse.client import _safe_round_ms
from chkit_plugin_backfill.chunking import planner
from chkit_plugin_backfill.logging_utils import format_bytes
from chkit_plugin_obsessiondb.remote_executor import _elapsed_ms


@pytest.mark.parametrize(
    ("elapsed", "expected"),
    [
        # system.processes.elapsed (seconds) -> ms, as TS Math.round(Number(e) * 1000)
        ("0.0005", 1),
        ("0.0025", 3),
        ("1.0125", 1013),
        (0.0005, 1),
        (0.0025, 3),
        ("0.0004", 0),
        ("0.012345", 12),
        (2, 2000),
    ],
)
def test_elapsed_ms_rounds_ties_up_like_js(elapsed: object, expected: int) -> None:
    assert _safe_round_ms(elapsed) == expected
    assert _elapsed_ms(elapsed) == expected


def test_elapsed_ms_keeps_none_for_unparseable_values() -> None:
    assert _safe_round_ms("abc") is None
    assert _safe_round_ms(None) is None
    assert _elapsed_ms("abc") is None
    assert _elapsed_ms(None) is None


@pytest.mark.parametrize(
    ("bytes_", "expected"),
    [
        # TS (bytes / unit).toFixed(1): 1.25 -> "1.3", where f"{1.25:.1f}" is "1.2"
        (1280, "1.3 KiB"),
        (1024 * 2.25, "2.3 KiB"),
        (1024**2 * 1.25, "1.3 MiB"),
        (1024**3 * 2.25, "2.3 GiB"),
        (1024**4 * 1.25, "1.3 TiB"),
        (1024**3 * 3.75, "3.8 GiB"),
        (1023, "1023 B"),
    ],
)
def test_format_bytes_rounds_ties_up_like_js_to_fixed(bytes_: float, expected: str) -> None:
    assert format_bytes(bytes_) == expected


def test_planner_timing_rounds_ties_up_like_js(monkeypatch: pytest.MonkeyPatch) -> None:
    # TS logs Math.round(performance.now() - startedAt) ms.
    monkeypatch.setattr(planner.time, "monotonic", lambda: 0.0025)
    assert planner._ms_since(0.0) == 3
    monkeypatch.setattr(planner.time, "monotonic", lambda: 0.0005)
    assert planner._ms_since(0.0) == 1
