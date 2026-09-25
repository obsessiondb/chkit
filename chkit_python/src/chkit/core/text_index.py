"""Render and parse the ClickHouse ``text(...)`` skip index type.

Mirrors ``packages/core/src/text-index.ts``. ClickHouse keeps parameters in
the order the DDL was written (``system.data_skipping_indices.type_full``), so
comparisons go through parse + render rather than string equality.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from chkit.core.key_clause import split_top_level_comma
from chkit.core.sql_normalizer import normalize_sql_fragment

if TYPE_CHECKING:
    from chkit.core.model import SkipIndexText

_Kind = Literal["sql", "flag", "number", "string"]

# (model field, DDL key, kind) in render order.
PARAMS: tuple[tuple[str, str, _Kind], ...] = (
    ("tokenizer", "tokenizer", "sql"),
    ("preprocessor", "preprocessor", "sql"),
    ("postprocessor", "postprocessor", "sql"),
    ("support_phrase_search", "support_phrase_search", "flag"),
    ("dictionary_block_size", "dictionary_block_size", "number"),
    (
        "dictionary_block_frontcoding_compression",
        "dictionary_block_frontcoding_compression",
        "flag",
    ),
    ("posting_list_block_size", "posting_list_block_size", "number"),
    ("posting_list_codec", "posting_list_codec", "string"),
)


def render_text_index_type(index: SkipIndexText) -> str:
    parts: list[str] = []
    for field, key, kind in PARAMS:
        value = getattr(index, field)
        if value is None:
            continue
        if kind == "sql":
            parts.append(f"{key} = {normalize_sql_fragment(str(value))}")
        elif kind == "flag":
            parts.append(f"{key} = {1 if value else 0}")
        elif kind == "number":
            parts.append(f"{key} = {value}")
        else:
            parts.append(f"{key} = '{value}'")
    return f"text({', '.join(parts)})"


def parse_text_index_params(args: str) -> dict[str, str | bool | int]:
    """Parse the argument list of a ``text(...)`` index type into model fields."""
    values: dict[str, str] = {}
    for part in split_top_level_comma(args):
        key, sep, raw = part.partition("=")
        if sep:
            values[key.strip()] = raw.strip()
    params: dict[str, str | bool | int] = {"tokenizer": ""}
    for field, key, kind in PARAMS:
        value = values.get(key)
        if value is None:
            continue
        if kind == "sql":
            params[field] = normalize_sql_fragment(value)
        elif kind == "flag":
            params[field] = value == "1" or value.lower() == "true"
        elif kind == "number":
            params[field] = int(value)
        else:
            quoted = len(value) > 1 and value[0] == value[-1] == "'"
            params[field] = value[1:-1] if quoted else value
    return params
