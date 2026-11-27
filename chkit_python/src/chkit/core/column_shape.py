"""The shape the migration planner compares a column by."""

from __future__ import annotations

import json
from typing import Any

from chkit.core.column_default import (
    literal_default_fingerprint,
    parse_column_default,
    render_default,
)
from chkit.core.model import ColumnDefinition
from chkit.core.sql import column_codec_fingerprint, column_type_fingerprint


def _normalized_column(column: ColumnDefinition) -> dict[str, Any]:
    """Column shape ignoring name + renamed_from, with the type as rendered.

    Compare what the DSL renders: inline ``Nullable(T)`` and ``nullable=True``
    are equivalent, while an additional or differently placed wrapper is not.
    A literal default compares by the SQL it renders, so the literal ``7`` and
    the expression ``'7'`` that pull reads back are the same default (#466).
    An expression keeps its comments, which the snapshot records as written.
    """
    data = column.model_dump(mode="json", by_alias=False)
    data.pop("name", None)
    data.pop("renamed_from", None)
    data.pop("nullable", None)
    # ClickHouse stores ``Decimal(10,2)`` as ``Decimal(10, 2)`` (#466).
    data["type"] = column_type_fingerprint(column)
    if column.default is not None:
        parsed = parse_column_default(column.default)
        sql = parsed.sql if parsed.kind == "expression" else render_default(column.default)
        data["default"] = literal_default_fingerprint(sql) or sql
    # Codecs compare in the form ClickHouse stores them, like drift (#465).
    data["codec"] = column_codec_fingerprint(column)
    return data


def _column_identity(column: ColumnDefinition) -> str:
    """JSON-stable shape of a column ignoring name + renamed_from."""
    return json.dumps(_normalized_column(column), sort_keys=True, default=str)


def _columns_equal(left: ColumnDefinition, right: ColumnDefinition) -> bool:
    return _column_identity(left) == _column_identity(right)
