"""Text index normalization and SQL round trips, in parity with TypeScript."""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING

from chkit.core.text_index_sql import (
    format_text_sql,
    normalize_text_index_sql,
    text_expression_fingerprint,
    text_sql_fingerprint,
    text_sql_tokens,
)

if TYPE_CHECKING:
    from chkit.core.model import SkipIndexText

TEXT_INDEX_GRANULARITY = 100_000_000
PARAMETERS = (
    ("tokenizer", "tokenizer", "sql"),
    ("preprocessor", "preprocessor", "sql"),
    ("postprocessor", "postprocessor", "sql"),
    ("support_phrase_search", "support_phrase_search", "boolean"),
    ("dictionary_block_size", "dictionary_block_size", "number"),
    (
        "dictionary_block_frontcoding_compression",
        "dictionary_block_frontcoding_compression",
        "boolean",
    ),
    ("posting_list_block_size", "posting_list_block_size", "number"),
    ("posting_list_codec", "posting_list_codec", "codec"),
)


def render_text_index_type(index: SkipIndexText) -> str:
    if not text_sql_tokens(index.tokenizer):
        raise ValueError("A non-empty tokenizer is required")
    parts = []
    for field, key, kind in PARAMETERS:
        value = getattr(index, field)
        if value is None:
            continue
        if kind == "sql":
            if not isinstance(value, str) or not text_sql_tokens(value):
                raise ValueError(f"{field} must be non-empty SQL")
            sql = normalize_text_index_sql(value)
        elif kind == "boolean":
            if not isinstance(value, bool):
                raise ValueError(f"{field} must be a boolean")
            sql = "1" if value else "0"
        elif kind == "number":
            if type(value) is not int or not 0 < value <= 2**53 - 1:
                raise ValueError(f"{field} must be a positive safe integer")
            sql = str(value)
        else:
            if value not in ("none", "bitpacking"):
                raise ValueError(f"{field} must be none or bitpacking")
            sql = f"'{value}'"
        parts.append(f"{key} = {sql}")
    return f"text({', '.join(parts)})"


def parse_text_index_params(args: str) -> dict[str, str | int | bool]:
    tokens = text_sql_tokens(args)
    groups: list[list[str]] = [[]]
    depth = 0
    for token in tokens:
        if token in ("(", "[", "{"):
            depth += 1
        if token in (")", "]", "}"):
            depth -= 1
        if token == "," and depth == 0:
            groups.append([])
        else:
            groups[-1].append(token)
    params: dict[str, str | int | bool] = {}
    for group in groups:
        parameter = next((p for p in PARAMETERS if group and p[1] == group[0]), None)
        if parameter is None or len(group) < 3 or group[1] != "=":
            raise ValueError(
                f"Invalid or unsupported text index parameter: {format_text_sql(group)}"
            )
        field, key, kind = parameter
        if field in params:
            raise ValueError(f"Duplicate text index parameter: {key}")
        raw = format_text_sql(group[2:])
        if kind == "boolean":
            if raw.lower() not in ("0", "1", "true", "false"):
                raise ValueError(f"Invalid boolean for {key}: {raw}")
            params[field] = raw.lower() in ("1", "true")
        elif kind == "number":
            if not re.fullmatch(r"\d+", raw) or not 0 < int(raw) <= 2**53 - 1:
                raise ValueError(f"Invalid integer for {key}: {raw}")
            params[field] = int(raw)
        elif kind == "codec":
            if raw not in ("'none'", "'bitpacking'"):
                raise ValueError(f"Invalid codec: {raw}")
            params[field] = raw[1:-1]
        else:
            params[field] = raw
    if not params.get("tokenizer"):
        raise ValueError("A non-empty tokenizer is required")
    return params


def canonicalize_text_index(index: SkipIndexText) -> SkipIndexText:
    sql = render_text_index_type(index)
    return index.model_copy(
        update={
            "expression": text_expression_fingerprint(index.expression),
            "granularity": TEXT_INDEX_GRANULARITY,
            **parse_text_index_params(sql[5:-1]),
        }
    )


def text_index_fingerprint(index: SkipIndexText) -> str:
    canonical = canonicalize_text_index(index)
    values = canonical.model_dump(exclude_none=True)
    for field in ("expression", "tokenizer", "preprocessor", "postprocessor"):
        value = getattr(canonical, field)
        if value is not None:
            values[field] = text_sql_fingerprint(value)
    return json.dumps(values, sort_keys=True)
