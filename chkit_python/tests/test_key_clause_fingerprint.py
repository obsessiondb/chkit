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
    assert key_clause_fingerprint("`a''b`") != key_clause_fingerprint("`a'b`")


def test_a_quoted_name_decodes_its_escapes_as_clickhouse_does() -> None:
    # ClickHouse reads `a\x41` as aA and `a\nb` with a newline, but keeps the
    # backslash of an unknown escape: `a\q` names the column a\q, not aq.
    assert key_clause_fingerprint("`a\\x41`") == key_clause_fingerprint("aA")
    assert key_clause_fingerprint("`a\\nb`") == key_clause_fingerprint("`a\nb`")
    assert key_clause_fingerprint("`a\\q`") == key_clause_fingerprint("`a\\\\q`")
    assert key_clause_fingerprint("`a\\q`") != key_clause_fingerprint("aq")


def test_a_bare_null_is_the_literal_not_a_column_named_null() -> None:
    assert key_clause_fingerprint("if(`null` = 1, a, b)") != key_clause_fingerprint(
        "if(NULL = 1, a, b)"
    )
    assert key_clause_fingerprint("if(null = 1, a, b)") != key_clause_fingerprint(
        'if("null" = 1, a, b)'
    )


def test_null_after_a_dot_is_a_name_the_null_map_of_a_nullable_column() -> None:
    # ClickHouse writes c.null back as c.`null`.
    assert key_clause_fingerprint("c.null") == key_clause_fingerprint("c.`null`")
    assert key_clause_fingerprint("`c` . null") == key_clause_fingerprint("c.`null`")


def test_fingerprint_matches_the_ts_port() -> None:
    # packages/core/src/key-clause-fingerprint.test.ts expects these exact strings.
    assert (
        key_clause_fingerprint('`id`, `a, b`, `x\\`y`, "q\\\\z", toStartOfHour( ts ) -- c')
        == "`'id' , `'a, b' , `'x`y' , `'q\\\\z' , `'toStartOfHour' ( `'ts' )"
    )
    assert (
        key_clause_fingerprint("if(NULL, `a\\x41`, '\\x41'), `\\xC3\\xA9`, `a\\xZZ`")
        == "`'if' ( NULL , `'aA' , '\\x41' ) , `'\\xc3\\xa9' , `a\\xZZ`"
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


def test_a_name_with_or_without_escapes_compares_as_the_column_clickhouse_reads() -> None:
    def escaped(order_by: list[str]) -> TableDefinition:
        return table(
            database="app",
            name="events",
            engine="MergeTree()",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "a\\q", "type": "String"},
                {"name": "aq", "type": "String"},
                {"name": "eA", "type": "String"},
            ],
            order_by=order_by,
        )

    def types(old: list[str], new: list[str]) -> list[str]:
        return [op.type for op in plan_diff([escaped(old)], [escaped(new)]).operations]

    assert types(["id", "a\\q"], ["id", "`a\\q`"]) == []
    assert types(["id", "`a\\q`"], ["id", "aq"]) == _RECREATE
    assert types(["id", "eA"], ["id", "`e\\x41`"]) == []


def test_a_column_named_true_compares_equal_however_it_is_quoted() -> None:
    # ClickHouse writes it bare: sorting_key for ORDER BY (`id`, `true`) is `id, true`.
    def with_true(order_by: list[str]) -> TableDefinition:
        return table(
            database="app",
            name="events",
            engine="MergeTree()",
            columns=[{"name": "id", "type": "UInt64"}, {"name": "true", "type": "UInt8"}],
            order_by=order_by,
        )

    pulled = split_top_level_comma("id, true")
    assert plan_diff([with_true(["id", "true"])], [with_true(pulled)]).operations == []
    assert plan_diff([with_true(["id", "`true`"])], [with_true(["id", "true"])]).operations == []


def test_a_qualified_null_spelled_bare_or_quoted_plans_nothing() -> None:
    assert _plan_types(["id", "if(a.null, 0, 1)"], ["id", "if(a.`null`, 0, 1)"]) == []
    assert (
        _plan_types(["id", "if(isNull(a), 0, 1)"], ["id", "if(isNull(`null`), 0, 1)"])
        == _RECREATE
    )


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


def test_drift_a_column_named_null_against_the_null_literal() -> None:
    # ClickHouse always quotes a column named null, and writes one named true bare.
    assert _drift_codes(["id", "if(`null` = 1, id, 0)"], "id, if(NULL = 1, id, 0)") == [
        "primary_key_mismatch",
        "order_by_mismatch",
    ]
    assert _drift_codes(["id", "if(`true` = 1, id, 0)"], "id, if(true = 1, id, 0)") is None
    # A null after a dot is the null map of a Nullable column, which ClickHouse quotes.
    assert _drift_codes(["id", "if(a.null, 0, 1)"], "id, if(a.`null`, 0, 1)") is None


def test_drift_an_expression_split_or_spaced_differently_reads_clean() -> None:
    assert _drift_codes(["id", "cityHash64(a", "b)"], "id, cityHash64(a, b)") is None
    assert _drift_codes(["id", "toStartOfHour( id )"], "(id, toStartOfHour(id))") is None
