"""Table settings the server fills in or refuses to change (#466).

Mirrors ``packages/core/src/table-settings.ts``.
"""

from __future__ import annotations

import math
import re

from chkit.core.engine import is_merge_tree_engine
from chkit.core.jsnum import js_number_to_string
from chkit.core.model import SettingValue, SkipIndexDefinition
from chkit.core.sql_lexer import js_trim

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

# Past this exponent ``_canonical_decimal`` keeps the exponent.
_MAX_PLAIN_EXPONENT = 400

_DECIMAL_RE = re.compile(r"([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?", re.IGNORECASE | re.ASCII)


def setting_value_fingerprint(value: SettingValue) -> str:
    """A setting value in one form for comparison.

    ClickHouse stores ``2.0`` as ``2.`` and ``1e6`` as ``1000000.``, and pull
    reads every value back as the SQL text, so ``8192``, ``"8192"`` and
    ``8192.`` are the same value. A number compares exactly, as decimal text:
    a float would make two UInt64 values above 2^53 equal. ``true``/``false``
    compare as the ``1``/``0`` ClickHouse reads them as, in any case.
    """
    if isinstance(value, bool):
        return "1" if value else "0"
    text = js_trim(js_number_to_string(value) if isinstance(value, float) else str(value))
    lower = text.lower()
    if lower == "true":
        return "1"
    if lower == "false":
        return "0"
    number = _number_fingerprint(text)
    return text if number is None else number


_MIN_INT64 = -(2**63)
_MAX_UINT64 = 2**64 - 1


def _number_fingerprint(text: str) -> str | None:
    """A number as ClickHouse reads it (TS ``numberFingerprint``): an integer
    literal within Int64/UInt64 is exact, while a literal with a ``.`` or an
    exponent, or an integer outside that range, is a Float64. So
    ``9007199254740993.`` is 9007199254740992 and differs from the integer
    ``9007199254740993``, and ``2.``, ``2.0`` and ``2`` are the same value. The
    text is the exact decimal of that value."""
    exact = _canonical_decimal(text)
    if exact is None:
        return None
    # _canonical_decimal keeps an exponent for a huge value, which is no Int64/UInt64 anyway.
    plain_integer = not re.search(r"[.eE]", text) and "e" not in exact
    if plain_integer and _MIN_INT64 <= int(exact) <= _MAX_UINT64:
        return exact
    value = float(text)
    if not math.isfinite(value):
        return _canonical_decimal(text)
    if value.is_integer():
        return str(int(value))
    return _canonical_decimal(js_number_to_string(value))


def _canonical_decimal(text: str) -> str | None:  # noqa: PLR0911
    """Number text as a canonical decimal (TS ``canonicalDecimal``): no exponent,
    no leading zeros, no trailing fraction zeros or ``.``, and ``0`` for any
    zero. ``1e6``, ``1000000.`` and ``1000000`` give ``1000000``; ``1e-7`` gives
    ``0.0000001``. A value too far from 1 keeps an exponent
    (``<digits>e<exponent>``) instead of thousands of zeros. None when the text
    is not a number."""
    match = _DECIMAL_RE.fullmatch(text)
    if match is None:
        return None
    sign, integer = match.group(1), match.group(2)
    fraction, exponent = match.group(3) or "", match.group(4) or "0"
    if integer == "" and fraction == "":
        return None
    digits = f"{integer}{fraction}".lstrip("0")
    if digits == "":
        return "0"
    exp = int(exponent) - len(fraction)
    stripped = digits.rstrip("0")
    exp += len(digits) - len(stripped)
    digits = stripped
    prefix = "-" if sign == "-" else ""
    if exp > _MAX_PLAIN_EXPONENT or exp < -_MAX_PLAIN_EXPONENT:
        return f"{prefix}{digits}e{exp}"
    if exp >= 0:
        return f"{prefix}{digits}{'0' * exp}"
    point = len(digits) + exp
    if point > 0:
        return f"{prefix}{digits[:point]}.{digits[point:]}"
    return f"{prefix}0.{'0' * -point}{digits}"


def _is_enabled(value: SettingValue | None) -> bool:
    if value is None:
        return False
    return setting_value_fingerprint(value) != "0"


def _has_auto_minmax_indexes(settings: dict[str, SettingValue] | None) -> bool:
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
    if indexes is None or not _has_auto_minmax_indexes(settings):
        return indexes
    return [index for index in indexes if not index.name.startswith(AUTO_MINMAX_INDEX_PREFIX)]


def with_default_index_granularity(
    engine: str,
    settings: dict[str, SettingValue] | None,
    index_granularity: int = DEFAULT_INDEX_GRANULARITY,
) -> dict[str, SettingValue] | None:
    """A MergeTree table's settings with ``index_granularity`` filled in as
    ClickHouse does: ``index_granularity`` is the server's MergeTree default
    (``clickhouse.indexGranularity``)."""
    if not is_merge_tree_engine(engine):
        return settings
    if settings is not None and "index_granularity" in settings:
        return settings
    return {**(settings or {}), "index_granularity": index_granularity}


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


def readonly_settings_layout_sql(keys: list[str], index_granularity: int) -> str:
    """SQL over ``system.tables`` giving the ``keys`` read-only settings of a
    table as stored in ``engine_full``, one element per setting ('' when absent;
    a missing ``index_granularity`` reads as ``index_granularity``, the server
    default). The cutover adds it to the layout that tells the old table from
    the new one, so a change of only these settings can be cut over and an
    interrupted swap is never replayed (#511)."""
    elements: list[str] = []
    for key in keys:
        stored = f"extract(engine_full, '(?:SETTINGS |, ){key} = ([^,]*)')"
        value = (
            f"if({stored} = '', '{index_granularity}', {stored})"
            if key == "index_granularity"
            else stored
        )
        elements.append(_normalized_setting_sql(value))
    return f"tuple({', '.join(elements)})"


def readonly_settings_expected_sql(
    keys: list[str], settings: dict[str, SettingValue] | None
) -> str:
    """The tuple ``readonly_settings_layout_sql`` gives for a table created with
    ``settings`` (which must have ``index_granularity`` filled in): each value
    as the CREATE renders it, through the same normalization in SQL."""
    elements: list[str] = []
    for key in keys:
        value = settings.get(key) if settings is not None else None
        rendered = "" if value is None else render_setting_value(value)
        elements.append(_normalized_setting_sql(_string_literal(rendered)))
    return f"tuple({', '.join(elements)})"


def render_setting_value(value: SettingValue) -> str:
    """A setting value as chkit writes it in SQL, as TS ``String(value)`` does."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return js_number_to_string(value)
    return str(value)


def _normalized_setting_sql(value: str) -> str:
    """A number compares by value, as ``setting_value_fingerprint`` does: a
    table created with ``1e6`` stores ``1000000.``, the snapshot table chkit
    creates from the same definition may store ``1000000``, and they are the
    same layout. Float64 is exact enough here: read-only settings hold small
    numbers and flags, unlike the column defaults ``setting_value_fingerprint``
    also compares. ``true``/``false`` read as ``1``/``0``, as there: ClickHouse
    stores the word as written, so a table created with ``true`` matches a
    snapshot that says ``1``."""
    return (
        f"multiIf(lower({value}) = 'true', '1', lower({value}) = 'false', '0', "
        f"ifNull(toString(toFloat64OrNull({value})), {value}))"
    )


def _string_literal(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"
