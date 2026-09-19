"""Index-only projections — port of TS 3f1db03 (#193).

Direct ports of the core tests in ``packages/core/src/index.test.ts`` plus the
create-table-parser tests in ``packages/clickhouse/src/index.test.ts``.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from chkit.cli.commands.pull_render import render_schema_file
from chkit.clickhouse.create_table_parser import (
    parse_projections_from_create_table_query,
)
from chkit.core.model import ProjectionDefinition, table
from chkit.core.planner import plan_diff
from chkit.core.projection import normalize_projection_index
from chkit.core.sql import to_create_sql
from chkit.core.validate import validate_definitions


def test_renders_an_index_only_projection_without_wrapping_parens() -> None:
    counterparts = table(
        database="solana",
        name="address_counterparts",
        columns=[
            {"name": "sender", "type": "String"},
            {"name": "receiver", "type": "String"},
        ],
        engine="AggregatingMergeTree()",
        primary_key=["sender"],
        order_by=["sender", "receiver"],
        projections=[{"name": "by_receiver", "index": "receiver, sender", "type": "basic"}],
    )

    sql = to_create_sql(counterparts)
    assert "PROJECTION `by_receiver` INDEX (receiver, sender) TYPE basic" in sql
    assert "PROJECTION `by_receiver` (" not in sql


def test_renders_both_projection_kinds_on_the_same_table() -> None:
    events = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "source", "type": "String"},
        ],
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
        projections=[
            {"name": "p_by_source", "index": "source", "type": "basic"},
            {"name": "p_recent", "query": "SELECT id ORDER BY id DESC LIMIT 10"},
        ],
    )

    sql = to_create_sql(events)
    assert "PROJECTION `p_by_source` INDEX source TYPE basic" in sql
    assert "PROJECTION `p_recent` (SELECT id ORDER BY id DESC LIMIT 10)" in sql


def _render_index(index: str) -> str:
    sql = to_create_sql(
        table(
            database="app",
            name="events",
            columns=[
                {"name": "a", "type": "String"},
                {"name": "b", "type": "String"},
                {"name": "ts", "type": "DateTime"},
            ],
            engine="MergeTree()",
            primary_key=["a"],
            order_by=["a"],
            projections=[{"name": "p", "index": index, "type": "basic"}],
        )
    )
    for line in sql.split("\n"):
        if "PROJECTION" in line:
            return line.strip()
    return ""


def test_renders_index_expressions_the_way_clickhouse_normalizes_them() -> None:
    assert _render_index("b") == "PROJECTION `p` INDEX b TYPE basic"
    assert _render_index("(b)") == "PROJECTION `p` INDEX b TYPE basic"
    assert _render_index("(a, b)") == "PROJECTION `p` INDEX (a, b) TYPE basic"
    assert _render_index("a, b") == "PROJECTION `p` INDEX (a, b) TYPE basic"
    assert _render_index("(toYYYYMM(ts))") == "PROJECTION `p` INDEX toYYYYMM(ts) TYPE basic"
    assert (
        _render_index("(toYYYYMM(ts), a)")
        == "PROJECTION `p` INDEX (toYYYYMM(ts), a) TYPE basic"
    )
    # Redundant parens are peeled at every level, including inside a tuple...
    assert _render_index("((a, b))") == "PROJECTION `p` INDEX (a, b) TYPE basic"
    assert _render_index("(((a,b)))") == "PROJECTION `p` INDEX (a, b) TYPE basic"
    assert _render_index("(a, (b))") == "PROJECTION `p` INDEX (a, b) TYPE basic"
    assert _render_index("(a), (b)") == "PROJECTION `p` INDEX (a, b) TYPE basic"
    # ...but a genuine nested tuple is not redundant and survives.
    assert _render_index("(a, (b, c))") == "PROJECTION `p` INDEX (a, (b, c)) TYPE basic"
    # ClickHouse prints a space after every argument separator.
    assert (
        _render_index("(concat(a,b), ts)")
        == "PROJECTION `p` INDEX (concat(a, b), ts) TYPE basic"
    )
    assert (
        _render_index("cityHash64(a,b)")
        == "PROJECTION `p` INDEX cityHash64(a, b) TYPE basic"
    )
    # A paren inside a quoted identifier is text, not nesting.
    assert _render_index("(`weird)name`)") == "PROJECTION `p` INDEX `weird)name` TYPE basic"


def test_normalizes_index_expressions_idempotently() -> None:
    inputs = [
        "b",
        "(b)",
        "(a,b)",
        "((a,b))",
        "(((a,b)))",
        "(a), (b)",
        "(a, (b))",
        "(a, (b, c))",
        "concat(a,b)",
        "(concat(a,b), ts)",
        "(toYYYYMM(ts))",
        "(`weird)name`)",
    ]
    for text in inputs:
        once = normalize_projection_index(text)
        assert normalize_projection_index(once) == once


def _defs_with_index(index: str) -> list[object]:
    return [
        table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree()",
            primary_key=["id"],
            order_by=["id"],
            projections=[{"name": "p_by_id", "index": index, "type": "basic"}],
        )
    ]


def test_treats_parens_only_differences_in_an_index_projection_as_no_change() -> None:
    plan = plan_diff(_defs_with_index("(id)"), _defs_with_index("id"))  # type: ignore[arg-type]
    assert plan.operations == []


def test_rejects_a_projection_that_sets_both_query_and_index() -> None:
    events = table(
        database="app",
        name="events",
        columns=[{"name": "id", "type": "UInt64"}],
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
        projections=[
            {"name": "p", "query": "SELECT id", "index": "id", "type": "basic"}
        ],
    )

    codes = [issue.code for issue in validate_definitions([events])]
    assert "projection_ambiguous_kind" in codes


def test_rejects_an_index_only_projection_with_an_empty_index_expression() -> None:
    def build(index: str) -> object:
        return table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree()",
            primary_key=["id"],
            order_by=["id"],
            projections=[{"name": "p", "index": index, "type": "basic"}],
        )

    for empty in ["", "   ", "()"]:
        codes = [issue.code for issue in validate_definitions([build(empty)])]  # type: ignore[list-item]
        assert "projection_empty_index" in codes
    assert validate_definitions([build("id")]) == []  # type: ignore[list-item]


def test_plans_add_and_drop_for_index_only_projections() -> None:
    def base_table(projections: list[dict[str, str]]) -> object:
        return table(
            database="app",
            name="events",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "source", "type": "String"},
            ],
            engine="MergeTree()",
            primary_key=["id"],
            order_by=["id"],
            projections=projections,  # type: ignore[arg-type]
        )

    old_defs = [base_table([{"name": "p_drop", "index": "source", "type": "basic"}])]
    new_defs = [base_table([{"name": "p_add", "index": "source, id", "type": "basic"}])]

    plan = plan_diff(old_defs, new_defs)  # type: ignore[arg-type]
    assert [op.type for op in plan.operations] == [
        "alter_table_add_projection",
        "alter_table_drop_projection",
    ]
    assert (
        "ADD PROJECTION IF NOT EXISTS `p_add` INDEX (source, id) TYPE basic"
        in plan.operations[0].sql
    )


def test_parses_index_only_projection_from_create_table_query() -> None:
    query = (
        "CREATE TABLE solana.address_counterparts (`sender` String, `receiver` String, "
        "PROJECTION by_receiver INDEX (receiver, sender) TYPE basic) "
        "ENGINE = AggregatingMergeTree ORDER BY (sender, receiver)"
    )
    projections = parse_projections_from_create_table_query(query)
    assert len(projections) == 1
    assert projections[0].name == "by_receiver"
    assert projections[0].index == "(receiver, sender)"
    assert projections[0].type == "basic"
    assert projections[0].query is None


def test_parses_both_projection_kinds_from_create_table_query() -> None:
    query = (
        "CREATE TABLE app.events (`id` UInt64, `source` String, "
        "PROJECTION p_by_source INDEX source TYPE basic, "
        "PROJECTION `p_recent` (SELECT id ORDER BY id DESC LIMIT 10)) "
        "ENGINE = MergeTree ORDER BY id"
    )
    projections = parse_projections_from_create_table_query(query)
    assert len(projections) == 2
    assert projections[0].index == "source"
    assert projections[0].type == "basic"
    assert projections[1].name == "p_recent"
    assert projections[1].query == "SELECT id ORDER BY id DESC LIMIT 10"


def test_parses_backtick_named_index_only_projection() -> None:
    query = (
        "CREATE TABLE app.events (`a` String, `b` String, "
        "PROJECTION `p_one` INDEX b TYPE basic) "
        "ENGINE = MergeTree ORDER BY a"
    )
    projections = parse_projections_from_create_table_query(query)
    assert len(projections) == 1
    assert projections[0].name == "p_one"
    assert projections[0].index == "b"
    assert projections[0].type == "basic"


def test_parses_multiline_show_create_with_both_projection_kinds() -> None:
    query = (
        "CREATE TABLE solana.address_counterparts\n"
        "(\n"
        "    `sender` String,\n"
        "    `receiver` String,\n"
        "    `cnt` UInt64,\n"
        "    PROJECTION by_receiver INDEX (receiver, sender) TYPE basic,\n"
        "    PROJECTION p_top\n"
        "    (\n"
        "        SELECT\n"
        "            receiver,\n"
        "            sum(cnt)\n"
        "        GROUP BY receiver\n"
        "    )\n"
        ")\n"
        "ENGINE = AggregatingMergeTree\n"
        "ORDER BY (sender, receiver)"
    )
    projections = parse_projections_from_create_table_query(query)
    assert len(projections) == 2
    assert projections[0].name == "by_receiver"
    assert projections[0].index == "(receiver, sender)"
    assert projections[0].type == "basic"
    assert projections[1].name == "p_top"
    assert projections[1].query == "SELECT receiver, sum(cnt) GROUP BY receiver"


def test_projection_requires_a_kind_at_construction() -> None:
    with pytest.raises(ValidationError):
        ProjectionDefinition(name="p")


def test_index_only_projection_requires_type_at_construction() -> None:
    with pytest.raises(ValidationError):
        ProjectionDefinition(name="p", index="id")


def test_pull_render_emits_index_only_projection() -> None:
    definition = table(
        database="solana",
        name="address_counterparts",
        columns=[
            {"name": "sender", "type": "String"},
            {"name": "receiver", "type": "String"},
        ],
        engine="AggregatingMergeTree()",
        primary_key=["sender"],
        order_by=["sender", "receiver"],
        projections=[
            {"name": "by_receiver", "index": "receiver, sender", "type": "basic"}
        ],
    )
    content = render_schema_file([definition])
    assert (
        'ProjectionDefinition(name="by_receiver", index="(receiver, sender)", '
        'type="basic")' in content
    )
