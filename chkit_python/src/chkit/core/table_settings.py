"""Table settings the server fills in or refuses to change (#466).

Mirrors ``packages/core/src/table-settings.ts``.
"""

from __future__ import annotations

import math
import re

from chkit.core.engine import is_merge_tree_engine
from chkit.core.model import SettingValue, SkipIndexDefinition

# ClickHouse writes ``index_granularity`` into the stored CREATE of every
# MergeTree table that does not declare it, and the setting can never change
# afterwards. chkit gives a MergeTree table the same value, so a schema that
# leaves it out, a snapshot, and the table pull reads back all agree.
DEFAULT_INDEX_GRANULARITY = 8192

# MergeTree settings ClickHouse refuses to change or reset on an existing table
# (READONLY_SETTING): ClickHouse 26.3 has the first seven, ObsessionDB adds the
# last four. The planner runs offline, so it uses the union: a change to any of
# them recreates the table.
READONLY_MERGE_TREE_SETTINGS: tuple[str, ...] = (
    "add_minmax_index_for_numeric_columns",
    "add_minmax_index_for_string_columns",
    "add_minmax_index_for_temporal_columns",
    "enable_mixed_granularity_parts",
    "index_granularity",
    "index_granularity_bytes",
    "table_disk",
    "add_minmax_index_for_block_number_column",
    "add_minmax_index_for_block_offset_column",
    "allow_tuple_element_aggregation",
    "share_nested_offsets",
)

# Prefix of the skip indexes the ``add_minmax_index_for_*`` settings create.
AUTO_MINMAX_INDEX_PREFIX = "auto_minmax_index_"

_NUMBER_RE = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?", re.IGNORECASE)


def setting_value_fingerprint(value: SettingValue) -> str:
    """A setting value in one form for comparison.

    ClickHouse stores ``2.0`` as ``2.`` and ``1e6`` as ``1000000.``, and pull
    reads every value back as the SQL text, so ``8192``, ``"8192"`` and
    ``8192.`` are the same value. Integral numbers print as exact integers so
    TS and chkit-py agree. Booleans keep their word: ClickHouse stores ``true``
    as written.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    text = str(value).strip()
    if not _NUMBER_RE.fullmatch(text):
        return text
    number = float(text)
    if not math.isfinite(number):
        return text
    return str(int(number)) if number.is_integer() else repr(number)


def _is_enabled(value: SettingValue | None) -> bool:
    if value is None:
        return False
    return setting_value_fingerprint(value).lower() not in ("0", "false")


def has_auto_minmax_indexes(settings: dict[str, SettingValue] | None) -> bool:
    """With any ``add_minmax_index_for_*`` setting on, ClickHouse creates hidden
    ``auto_minmax_index_<column>`` skip indexes and rejects a user index whose
    name has that prefix, so such an index is always the server's own."""
    return any(
        key.startswith("add_minmax_index_for_") and _is_enabled(value)
        for key, value in (settings or {}).items()
    )


def without_auto_minmax_indexes(
    indexes: list[SkipIndexDefinition] | None,
    settings: dict[str, SettingValue] | None,
) -> list[SkipIndexDefinition] | None:
    if indexes is None or not has_auto_minmax_indexes(settings):
        return indexes
    return [index for index in indexes if not index.name.startswith(AUTO_MINMAX_INDEX_PREFIX)]


def with_default_index_granularity(
    engine: str, settings: dict[str, SettingValue] | None
) -> dict[str, SettingValue] | None:
    """A MergeTree table's settings with ``index_granularity`` filled in as
    ClickHouse does."""
    if not is_merge_tree_engine(engine):
        return settings
    if settings is not None and "index_granularity" in settings:
        return settings
    return {**(settings or {}), "index_granularity": DEFAULT_INDEX_GRANULARITY}


def readonly_settings_fingerprint(settings: dict[str, SettingValue] | None) -> str:
    """The read-only settings of a table, each in comparison form."""
    return ",".join(
        f"{key}={setting_value_fingerprint(settings[key])}"
        for key in READONLY_MERGE_TREE_SETTINGS
        if settings is not None and key in settings
    )


def declared_readonly_settings(*settings: dict[str, SettingValue] | None) -> list[str]:
    """The read-only settings either definition declares, in list order."""
    return [
        key
        for key in READONLY_MERGE_TREE_SETTINGS
        if any(values is not None and key in values for values in settings)
    ]


def readonly_settings_layout_sql(keys: list[str]) -> str:
    """SQL over ``system.tables`` giving the ``keys`` read-only settings of a
    table as stored in ``engine_full``, one element per setting ('' when absent;
    a missing ``index_granularity`` reads as 8192). The cutover adds it to the
    layout that tells the old table from the new one, so a change of only these
    settings can be cut over and an interrupted swap is never replayed (#511).
    A number compares by value, as ``setting_value_fingerprint`` does: a table
    created with ``1e6`` stores ``1000000.``, the snapshot table chkit creates
    from the same definition may store ``1000000``, and they are the same layout."""
    elements: list[str] = []
    for key in keys:
        stored = f"extract(engine_full, '(?:SETTINGS |, ){key} = ([^,]*)')"
        value = (
            f"if({stored} = '', '{DEFAULT_INDEX_GRANULARITY}', {stored})"
            if key == "index_granularity"
            else stored
        )
        elements.append(f"ifNull(toString(toFloat64OrNull({value})), {value})")
    return f"tuple({', '.join(elements)})"
