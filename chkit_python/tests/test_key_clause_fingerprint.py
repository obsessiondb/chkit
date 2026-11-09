"""Key parts that collide once joined (#558).

Ports of ``packages/core/src/key-clause-fingerprint.test.ts`` and the #558
block of ``packages/cli/src/test/drift.test.ts``. A key over columns ``a`` and
``b`` is not a key over one column named ``a, b``, although the old comparison
joined the parts with commas and dropped every backtick and space.
"""

from __future__ import annotations

from chkit.cli.commands.drift_compare import compare_table_shape
from chkit.clickhouse.introspect import IntrospectedTable
from chkit.core.key_clause import key_clause_fingerprint, split_top_level_comma
from chkit.core.model import ColumnDefinition, TableDefinition, table
from chkit.core.planner import plan_diff

_COLUMNS = [
    {"name": "id", "type": "UInt64"},
    {"name": "a", "type": "String"},
    {"name": "b", "type": "String"},
    {"name": "a, b", "type": "String"},
    {"name": "a b", "type": "String"},
    {"name": "ab", "type": "String"},
]
_RECREATE = ["drop_table", "create_table"]


def _events(order_by: list[str], primary_key: list[str] | None = None) -> TableDefinition:
    return table(
        database="app",
        name="events",
        engine="MergeTree()",
        columns=_COLUMNS,
        order_by=order_by,
        primary_key=order_by if primary_key is None else primary_key,
    )


def _plan_types(old: list[str], new: list[str]) -> list[str]:
    return [op.type for op in plan_diff([_events(old)], [_events(new)]).operations]


def _live(key: str) -> IntrospectedTable:
    # What system.tables reports; primary_key is the sorting key here.
    return IntrospectedTable(
        database="app",
        name="events",
        columns=[ColumnDefinition(**column) for column in _COLUMNS],
        settings={},
        indexes=[],
        projections=[],
        engine="MergeTree",
        primary_key=key,
        order_by=key,
    )


def _drift_codes(order_by: list[str], key: str) -> list[str] | None:
    detail = compare_table_shape(_events(order_by, []), _live(key))
    return None if detail is None else detail.reason_codes


# --- fingerprint ---------------------------------------------------------


def test_a_quoted_name_keeps_its_commas_and_spaces() -> None:
    assert key_clause_fingerprint("`id`, `a, b`") != key_clause_fingerprint("`id`, `a`, `b`")
    assert key_clause_fingerprint("`a b`") != key_clause_fingerprint("`ab`")
    assert key_clause_fingerprint("a b") != key_clause_fingerprint("ab")


def test_whitespace_comments_and_identifier_quoting_carry_no_meaning() -> None:
    fingerprint = key_clause_fingerprint("`id`, toStartOfHour(`ts`), `a, b`")
    assert key_clause_fingerprint("id,toStartOfHour( ts ),`a, b`") == fingerprint
    assert key_clause_fingerprint('"id" ,\ttoStartOfHour(ts) /* c */, "a, b"') == fingerprint
    assert key_clause_fingerprint("id,\u00a0toStartOfHour(ts), `a, b`") == fingerprint


def test_a_string_literal_keeps_its_exact_text() -> None:
    assert key_clause_fingerprint("concat(a, 'x y')") != key_clause_fingerprint("concat(a, 'xy')")
    assert key_clause_fingerprint("concat(a, 'x, y')") != key_clause_fingerprint(
        "concat(a, 'x', 'y')"
    )


def test_escaped_quotes_and_backslashes_in_a_name_stay_unambiguous() -> None:
    assert key_clause_fingerprint("`c\\`d`") == key_clause_fingerprint("`c``d`")
    assert key_clause_fingerprint("`c\\`d`") != key_clause_fingerprint("`c`, `d`")
    assert key_clause_fingerprint("`x\\\\`") != key_clause_fingerprint("`x`")


def test_fingerprint_matches_the_ts_port() -> None:
    # The exact string the TS keyClauseFingerprint returns for this input.
    assert (
        key_clause_fingerprint('`id`, `a, b`, `x\\`y`, "q\\\\z", toStartOfHour( ts ) -- c')
        == "`id` , `a, b` , `x\\`y` , `q\\\\z` , `toStartOfHour` ( `ts` )"
    )


# --- planner -------------------------------------------------------------


def test_separate_columns_and_one_column_named_a_comma_b_recreate_the_table() -> None:
    assert _plan_types(["id", "a", "b"], ["id", "a, b"]) == _RECREATE
    assert _plan_types(["id", "a, b"], ["id", "a", "b"]) == _RECREATE


def test_a_column_named_a_space_b_and_a_column_named_ab_recreate_the_table() -> None:
    assert _plan_types(["id", "a b"], ["id", "ab"]) == _RECREATE


def test_reordered_keys_that_read_the_same_once_joined_recreate_the_table() -> None:
    # Joined, both sorting keys used to read `id,a,b,a,b`.
    plan = plan_diff(
        [_events(["id", "a", "b", "a, b"], ["id", "a", "b"])],
        [_events(["id", "a, b", "a", "b"], ["id", "a, b"])],
    )
    assert [op.type for op in plan.operations] == _RECREATE


def test_an_expression_split_across_entries_plans_nothing() -> None:
    assert _plan_types(["id", "cityHash64(a", "b)"], ["id", "cityHash64(a, b)"]) == []
    assert _plan_types(["id, cityHash64(a,b)"], ["id", "cityHash64(a, b)"]) == []


def test_whitespace_and_identifier_quoting_plan_nothing() -> None:
    assert (
        _plan_types(
            ["id", "a, b", "toStartOfHour(  id )"], ["`id`", "`a, b`", "toStartOfHour(`id`)"]
        )
        == []
    )
    assert _plan_types(["id", "a b"], ['"id"', '"a b"']) == []


def test_the_key_clickhouse_reports_split_as_pull_splits_it_plans_nothing() -> None:
    # system.tables.sorting_key for ORDER BY (`id`, `a, b`, `a b`, cityHash64(a,b)).
    pulled = split_top_level_comma("id, `a, b`, `a b`, cityHash64(a, b)")
    assert pulled == ["id", "`a, b`", "`a b`", "cityHash64(a, b)"]
    schema = ["id", "a, b", "a b", "cityHash64(a,b)"]
    assert _plan_types(schema, pulled) == []
    assert _plan_types(pulled, schema) == []
    assert _plan_types(pulled, ["id", "a", "b", "a b", "cityHash64(a,b)"]) == _RECREATE


# --- drift ---------------------------------------------------------------


def test_drift_columns_a_b_against_one_column_named_a_comma_b() -> None:
    codes = ["primary_key_mismatch", "order_by_mismatch"]
    assert _drift_codes(["id", "a", "b"], "id, `a, b`") == codes
    assert _drift_codes(["id", "a, b"], "id, a, b") == codes


def test_drift_a_column_named_a_space_b_against_a_column_named_ab() -> None:
    assert _drift_codes(["id", "a b"], "id, ab") == ["primary_key_mismatch", "order_by_mismatch"]


def test_drift_the_key_as_clickhouse_reports_it_reads_clean() -> None:
    schema = _events(["id", "a, b", "a b", "cityHash64(a,b)"], [])
    live = _live("id, `a, b`, `a b`, cityHash64(a, b)")
    assert compare_table_shape(schema, live) is None

    class _Identity:
        def expression(self, fragment: str) -> str | None:
            return fragment

        def query(self, fragment: str) -> str | None:
            return None

    assert compare_table_shape(schema, live, _Identity()) is None


def test_drift_an_expression_split_or_spaced_differently_reads_clean() -> None:
    assert _drift_codes(["id", "cityHash64(a", "b)"], "id, cityHash64(a, b)") is None
    assert _drift_codes(["id", "toStartOfHour( id )"], "(id, toStartOfHour(id))") is None
