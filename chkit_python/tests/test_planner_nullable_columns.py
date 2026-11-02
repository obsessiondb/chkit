"""Planner: inline ``Nullable(T)`` and ``nullable=True`` compare as rendered (#433, port of #275)."""

from __future__ import annotations

from typing import Any

import pytest

from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import TableDefinition, table
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql


def _definition(column: dict[str, Any]) -> list[TableDefinition]:
    return canonicalize_definitions(
        [
            table(
                database="app",
                name="events",
                engine="MergeTree()",
                columns=[{"name": "id", "type": "UInt64"}, column],
                primary_key=["id"],
                order_by=["id"],
            )
        ]
    )


def _op_types(old: list[TableDefinition], new: list[TableDefinition]) -> list[str]:
    return [operation.type for operation in plan_diff(old, new).operations]


@pytest.mark.parametrize(
    "type_", ["String", "DateTime64(3, 'UTC')", "Decimal(12, 3)", "LowCardinality(String)"]
)
def test_inline_nullable_and_nullable_property_plan_nothing(type_: str) -> None:
    inline = _definition({"name": "value", "type": f"Nullable({type_})"})
    prop = _definition({"name": "value", "type": type_, "nullable": True})
    assert to_create_sql(inline[0]) == to_create_sql(prop[0])
    assert plan_diff(inline, prop).operations == []
    assert plan_diff(prop, inline).operations == []


@pytest.mark.parametrize(
    ("old_column", "new_column"),
    [
        ({"name": "value", "type": "Nullable(String)"}, {"name": "value", "type": "String"}),
        ({"name": "value", "type": "String"}, {"name": "value", "type": "String", "nullable": True}),
        (
            {"name": "value", "type": "Nullable(String)"},
            {"name": "value", "type": "UInt64", "nullable": True},
        ),
        (
            {"name": "value", "type": "Nullable(String)", "nullable": True},
            {"name": "value", "type": "String", "nullable": True},
        ),
        (
            {"name": "value", "type": "LowCardinality(Nullable(String))"},
            {"name": "value", "type": "LowCardinality(String)", "nullable": True},
        ),
        ({"name": "value", "type": "Array(Nullable(String))"}, {"name": "value", "type": "Array(String)"}),
    ],
)
def test_real_type_nullability_and_nested_wrapper_changes_still_modify(
    old_column: dict[str, Any], new_column: dict[str, Any]
) -> None:
    old = _definition(old_column)
    new = _definition(new_column)
    assert _op_types(old, new) == ["alter_table_modify_column"]
    assert _op_types(new, old) == ["alter_table_modify_column"]


def test_defaults_comments_and_codecs_still_compared() -> None:
    inline = _definition(
        {"name": "value", "type": "Nullable(String)", "default": "a", "comment": "original"}
    )
    prop: dict[str, Any] = {
        "name": "value",
        "type": "String",
        "nullable": True,
        "default": "a",
        "comment": "original",
    }
    assert plan_diff(inline, _definition(prop)).operations == []
    for column in (
        {**prop, "default": "b"},
        {**prop, "comment": "changed"},
        {**prop, "codec": {"kind": "ZSTD", "level": 3}},
    ):
        assert _op_types(inline, _definition(column)) == ["alter_table_modify_column"]


def test_codec_removal_when_only_the_nullable_spelling_also_changes() -> None:
    old = _definition(
        {"name": "value", "type": "Nullable(String)", "codec": {"kind": "ZSTD", "level": 3}}
    )
    new = _definition({"name": "value", "type": "String", "nullable": True})
    assert [operation.sql for operation in plan_diff(old, new).operations] == [
        "ALTER TABLE app.events MODIFY COLUMN `value` REMOVE CODEC;"
    ]


def test_rename_suggestion_matches_across_nullable_spellings() -> None:
    old = _definition({"name": "before", "type": "Nullable(String)"})
    new = _definition({"name": "after", "type": "String", "nullable": True})
    suggestions = plan_diff(old, new).rename_suggestions
    assert [(s.from_, s.to) for s in suggestions] == [("before", "after")]
