"""Rounding that TS does with ``Math.round`` / ``toFixed`` rounds a .5 tie up.

Python's ``round()`` and ``f"{x:.1f}"`` round a tie to even, so without
``chkit.core.jsnum`` the two CLIs print different numbers for the same input.
"""

from __future__ import annotations

import math

import pytest

from chkit.clickhouse.client import _safe_round_ms
from chkit.core.jsnum import js_math_round, js_to_fixed
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


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        # Expected values are what Node prints for Math.round of the same double.
        (2.5, 3),
        (-2.5, -2),
        (-1.5, -1),
        (-0.5, 0),
        (0.49999999999999994, 0),
        (-0.49999999999999994, 0),
        (-0.0025 * 1000, -2),
        (1e-300, 0),
        (-1e-300, 0),
        (4503599627370497.0, 4503599627370497),
        (-4503599627370497.0, -4503599627370497),
    ],
)
def test_js_math_round_matches_node_for_signed_values(value: float, expected: int) -> None:
    assert js_math_round(value) == expected


def test_js_math_round_passes_non_finite_values_through() -> None:
    assert js_math_round(math.inf) == math.inf
    assert js_math_round(-math.inf) == -math.inf
    assert math.isnan(js_math_round(math.nan))


@pytest.mark.parametrize(
    ("value", "negative_zero"),
    [(-0.0, True), (-0.1, True), (-5e-324, True), (-0.5, True), (0.3, False), (0.0, False)],
)
def test_js_math_round_keeps_the_sign_of_a_zero_result(value: float, negative_zero: bool) -> None:
    rounded = js_math_round(value)
    assert rounded == 0
    assert (math.copysign(1.0, rounded) < 0) is negative_zero


@pytest.mark.parametrize(
    ("value", "expected"),
    [(0.0, "0.0000000"), (1e-8, "0.0000000"), (-1e-8, "-0.0000000"), (0.00000015, "0.0000001")],
)
def test_js_to_fixed_prints_small_results_positionally(value: float, expected: str) -> None:
    assert js_to_fixed(value, 7) == expected


def test_elapsed_ms_rounds_negative_ties_toward_positive_infinity() -> None:
    assert _safe_round_ms("-0.0025") == -2
    assert _elapsed_ms("-0.0025") == -2


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        # Expected values are what Node prints for toFixed with one digit.
        (1e21, "1e+21"),
        (-1e21, "-1e+21"),
        (math.inf, "Infinity"),
        (-math.inf, "-Infinity"),
        (math.nan, "NaN"),
        (1e100 / 1024**4, "9.094947017729283e+87"),
        (9.99e20, "999000000000000000000.0"),
        (-1.25, "-1.3"),
        (-0.04, "-0.0"),
        (-0.0, "0.0"),
    ],
)
def test_js_to_fixed_matches_node_outside_the_plain_range(value: float, expected: str) -> None:
    assert js_to_fixed(value, 1) == expected


def test_format_bytes_prints_huge_sizes_like_js() -> None:
    # Node: formatBytes from packages/plugin-backfill/src/logging.ts
    assert format_bytes(1e100) == "9.094947017729283e+87 TiB"
    assert format_bytes(math.inf) == "Infinity TiB"
    assert format_bytes(1024**4 * 1e21) == "1e+21 TiB"
