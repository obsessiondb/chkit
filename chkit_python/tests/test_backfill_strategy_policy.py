"""Port of ``packages/plugin-backfill/src/chunking/strategy-policy.test.ts``."""

from __future__ import annotations

from chkit_plugin_backfill.chunking.strategy_policy import get_candidate_dimensions
from chkit_plugin_backfill.chunking.types import SortKey


def test_preserves_declared_sort_key_order_regardless_of_type() -> None:
    assert get_candidate_dimensions(
        [
            SortKey(
                name="event_time",
                type="DateTime",
                category="datetime",
                boundary_encoding="literal",
            ),
            SortKey(
                name="account_id",
                type="String",
                category="string",
                boundary_encoding="hex-latin1",
            ),
            SortKey(
                name="seq",
                type="UInt64",
                category="numeric",
                boundary_encoding="literal",
            ),
        ]
    ) == [0, 1, 2]
