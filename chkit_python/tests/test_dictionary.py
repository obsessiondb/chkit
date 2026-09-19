"""Dictionary primitive — port of TS 65c90d6 (#191).

Direct ports of the dictionary tests in ``packages/core/src/index.test.ts``,
``packages/clickhouse/src/index.test.ts``,
``packages/cli/src/test/runtime/safety-markers.test.ts``, and
``packages/cli/src/test/drift.test.ts``.
"""

from __future__ import annotations

from typing import Any

from chkit.cli.commands.dictionary_password_warnings import (
    detect_dictionary_password_warnings,
)
from chkit.cli.commands.drift_compare import SchemaObjectShape, compare_schema_objects
from chkit.cli.commands.generate_plan_pipeline import (
    apply_explicit_dictionary_renames,
)
from chkit.cli.commands.generate_rename_mappings import (
    collect_schema_rename_mappings,
    merge_dictionary_mappings,
    parse_rename_dictionary_mappings,
    remap_old_definitions_for_dictionary_renames,
    resolve_active_dictionary_mappings,
)
from chkit.cli.commands.pull import _dictionary_password_warnings
from chkit.cli.commands.pull_render import render_schema_file
from chkit.cli.safety_markers import (
    collect_destructive_operation_markers,
    collect_unmarked_destructive_statements,
)
from chkit.clickhouse.create_dictionary_parser import (
    ParsedDictionaryAttribute,
    parse_comment_from_create_dictionary_query,
    parse_dictionary_attributes_from_create_dictionary_query,
    parse_dictionary_primary_key_from_create_dictionary_query,
    parse_dictionary_range_from_create_dictionary_query,
    parse_dictionary_settings_from_create_dictionary_query,
    parse_layout_from_create_dictionary_query,
    parse_lifetime_from_create_dictionary_query,
    parse_source_from_create_dictionary_query,
)
from chkit.core.model import dictionary, is_schema_definition, table
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from chkit.core.validate import validate_definitions
from chkit_plugin_codegen.type_artifacts import generate_type_artifacts

_BASE_DICTIONARY: dict[str, Any] = {
    "database": "app",
    "name": "users_dict",
    "attributes": [
        {"name": "id", "type": "UInt64"},
        {"name": "name", "type": "String"},
        {"name": "email", "type": "String", "default": ""},
    ],
    "primary_key": ["id"],
    "source": (
        "MYSQL(host 'db' port 3306 user 'reader' password 'secret' "
        "db 'app' table 'users')"
    ),
    "layout": "HASHED()",
    "lifetime": "300",
}


def _dict(**overrides: Any) -> Any:
    return dictionary(**{**_BASE_DICTIONARY, **overrides})


# ---------- core: DSL + SQL rendering ----------


def test_dictionary_builds_a_valid_definition() -> None:
    d = _dict()
    assert d.kind == "dictionary"
    assert is_schema_definition(d)


def test_renders_create_dictionary_sql() -> None:
    sql = to_create_sql(_dict(comment="User lookup dictionary"))
    assert "CREATE DICTIONARY IF NOT EXISTS app.users_dict" in sql
    assert "PRIMARY KEY `id`" in sql
    assert "SOURCE(MYSQL(host 'db' port 3306" in sql
    assert "LAYOUT(HASHED())" in sql
    assert "LIFETIME(300)" in sql
    assert "COMMENT 'User lookup dictionary'" in sql


def test_renders_range_settings_and_bidirectional_clauses() -> None:
    d = _dict(
        attributes=[
            *_BASE_DICTIONARY["attributes"],
            {
                "name": "parent_id",
                "type": "UInt64",
                "hierarchical": True,
                "bidirectional": True,
            },
            {"name": "start_date", "type": "DateTime"},
            {"name": "end_date", "type": "DateTime"},
        ],
        layout="RANGE_HASHED()",
        range={"min": "start_date", "max": "end_date"},
        settings={"dictionary_use_async_executor": 1, "max_threads": 8},
    )
    sql = to_create_sql(d)
    assert "`parent_id` UInt64 HIERARCHICAL BIDIRECTIONAL" in sql
    assert "RANGE(MIN `start_date` MAX `end_date`)" in sql
    assert "SETTINGS(dictionary_use_async_executor = 1, max_threads = 8)" in sql


# ---------- core: validation ----------


def test_validation_missing_primary_key() -> None:
    codes = [i.code for i in validate_definitions([_dict(primary_key=[])])]
    assert "dictionary_missing_primary_key" in codes


def test_validation_primary_key_references_missing_attribute() -> None:
    codes = [
        i.code for i in validate_definitions([_dict(primary_key=["not_an_attribute"])])
    ]
    assert "dictionary_primary_key_missing_attribute" in codes


def test_validation_missing_source_layout_lifetime() -> None:
    codes = [
        i.code
        for i in validate_definitions([_dict(source="", layout="", lifetime="")])
    ]
    assert "dictionary_missing_source" in codes
    assert "dictionary_missing_layout" in codes
    assert "dictionary_missing_lifetime" in codes


def test_validation_default_and_expression_are_mutually_exclusive() -> None:
    codes = [
        i.code
        for i in validate_definitions(
            [
                _dict(
                    attributes=[
                        {"name": "id", "type": "UInt64"},
                        {
                            "name": "name",
                            "type": "String",
                            "default": "x",
                            "expression": "upper(name)",
                        },
                    ]
                )
            ]
        )
    ]
    assert "dictionary_attribute_default_expression_exclusive" in codes


def test_validation_range_references_missing_attribute() -> None:
    codes = [
        i.code
        for i in validate_definitions(
            [_dict(range={"min": "not_an_attribute", "max": "name"})]
        )
    ]
    assert "dictionary_range_missing_attribute" in codes


def test_validation_bidirectional_requires_hierarchical() -> None:
    codes = [
        i.code
        for i in validate_definitions(
            [
                _dict(
                    attributes=[
                        {"name": "id", "type": "UInt64"},
                        {"name": "parent_id", "type": "UInt64", "bidirectional": True},
                    ]
                )
            ]
        )
    ]
    assert "dictionary_bidirectional_requires_hierarchical" in codes


# ---------- core: planner ----------


def test_diff_unchanged_definitions_produce_no_operations() -> None:
    plan = plan_diff([_dict()], [_dict()])
    assert plan.operations == []


def test_diff_structural_change_produces_single_create_or_replace() -> None:
    plan = plan_diff([_dict()], [_dict(layout="COMPLEX_KEY_HASHED()")])
    assert len(plan.operations) == 1
    assert plan.operations[0].type == "create_dictionary"
    assert "CREATE OR REPLACE DICTIONARY" in plan.operations[0].sql
    assert plan.operations[0].risk == "caution"


def test_diff_removing_a_dictionary_produces_drop_dictionary() -> None:
    plan = plan_diff([_dict()], [])
    assert len(plan.operations) == 1
    assert plan.operations[0].type == "drop_dictionary"
    assert plan.operations[0].sql == "DROP DICTIONARY IF EXISTS app.users_dict;"
    assert plan.operations[0].risk == "danger"


def test_diff_real_password_change_produces_create_or_replace() -> None:
    plan = plan_diff(
        [_dict()],
        [
            _dict(
                source=(
                    "MYSQL(host 'db' port 3306 user 'reader' password "
                    "'a-different-secret' db 'app' table 'users')"
                )
            )
        ],
    )
    assert len(plan.operations) == 1
    assert plan.operations[0].type == "create_dictionary"
    assert "password 'a-different-secret'" in plan.operations[0].sql


def test_diff_hidden_source_placeholder_never_drives_a_diff() -> None:
    plan = plan_diff(
        [_dict()],
        [
            _dict(
                source=(
                    "MYSQL(host 'db' port 3306 user 'reader' password '[HIDDEN]' "
                    "db 'app' table 'users')"
                )
            )
        ],
    )
    assert plan.operations == []


def test_diff_hidden_source_does_not_suppress_unrelated_changes() -> None:
    plan = plan_diff(
        [_dict()],
        [
            _dict(
                source=(
                    "MYSQL(host 'db' port 3306 user 'reader' password '[HIDDEN]' "
                    "db 'app' table 'users')"
                ),
                layout="COMPLEX_KEY_HASHED()",
            )
        ],
    )
    assert len(plan.operations) == 1
    assert plan.operations[0].type == "create_dictionary"
    assert "password '[HIDDEN]'" in plan.operations[0].sql


def test_diff_adding_settings_produces_create_or_replace() -> None:
    plan = plan_diff([_dict()], [_dict(settings={"max_threads": 4})])
    assert len(plan.operations) == 1
    assert plan.operations[0].type == "create_dictionary"
    assert "SETTINGS(max_threads = 4)" in plan.operations[0].sql


def test_create_dictionary_ranks_after_create_table() -> None:
    users_table = table(
        database="app",
        name="users",
        columns=[{"name": "id", "type": "UInt64"}],
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
    )
    plan = plan_diff([], [users_table, _dict()])
    types = [op.type for op in plan.operations]
    assert types.index("create_table") < types.index("create_dictionary")


# ---------- create-dictionary-parser ----------


_PARSER_QUERY = """CREATE DICTIONARY default.users_dict
(
  `id` UInt64,
  `name` String,
  `email` String DEFAULT '',
  `parent_id` UInt64 HIERARCHICAL
)
PRIMARY KEY id
SOURCE(MYSQL(host 'db' port 3306 user 'reader' password '[HIDDEN]' db 'app' table 'users'))
LAYOUT(HASHED())
LIFETIME(MIN 0 MAX 300)
COMMENT 'User lookup dictionary'"""


def test_parses_attributes_including_defaults_and_modifiers() -> None:
    assert parse_dictionary_attributes_from_create_dictionary_query(
        _PARSER_QUERY
    ) == [
        ParsedDictionaryAttribute(name="id", type="UInt64"),
        ParsedDictionaryAttribute(name="name", type="String"),
        ParsedDictionaryAttribute(name="email", type="String", default=""),
        ParsedDictionaryAttribute(name="parent_id", type="UInt64", hierarchical=True),
    ]


def test_parses_primary_key() -> None:
    assert parse_dictionary_primary_key_from_create_dictionary_query(
        _PARSER_QUERY
    ) == ["id"]


def test_parses_source_layout_lifetime_comment() -> None:
    assert parse_source_from_create_dictionary_query(_PARSER_QUERY) == (
        "MYSQL(host 'db' port 3306 user 'reader' password '[HIDDEN]' "
        "db 'app' table 'users')"
    )
    assert parse_layout_from_create_dictionary_query(_PARSER_QUERY) == "HASHED()"
    assert parse_lifetime_from_create_dictionary_query(_PARSER_QUERY) == "MIN 0 MAX 300"
    assert (
        parse_comment_from_create_dictionary_query(_PARSER_QUERY)
        == "User lookup dictionary"
    )


def test_returns_empty_results_for_none_query() -> None:
    assert parse_dictionary_attributes_from_create_dictionary_query(None) == []
    assert parse_dictionary_primary_key_from_create_dictionary_query(None) == []
    assert parse_source_from_create_dictionary_query(None) is None


def test_parses_composite_primary_key_and_expression_attribute() -> None:
    composite_query = """CREATE DICTIONARY default.pairs_dict
(
  `a` String,
  `b` String,
  `full_name` String EXPRESSION concat(a, ' ', b)
)
PRIMARY KEY a, b
SOURCE(HTTP(url 'http://example.com/pairs' format 'TSV'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(300)"""
    assert parse_dictionary_primary_key_from_create_dictionary_query(
        composite_query
    ) == ["a", "b"]
    assert parse_dictionary_attributes_from_create_dictionary_query(
        composite_query
    ) == [
        ParsedDictionaryAttribute(name="a", type="String"),
        ParsedDictionaryAttribute(name="b", type="String"),
        ParsedDictionaryAttribute(
            name="full_name", type="String", expression="concat(a, ' ', b)"
        ),
    ]


_RANGE_QUERY = """CREATE DICTIONARY default.rates_dict
(
  `id` UInt64,
  `parent_id` UInt64 HIERARCHICAL BIDIRECTIONAL,
  `start_date` DateTime,
  `end_date` DateTime
)
PRIMARY KEY id
SOURCE(HTTP(url 'http://example.com/rates' format 'TSV'))
LIFETIME(MIN 0 MAX 300)
LAYOUT(RANGE_HASHED())
RANGE(MIN start_date MAX end_date)
SETTINGS(dictionary_use_async_executor = 1, max_threads = 8)"""


def test_parses_range_settings_and_bidirectional_modifier() -> None:
    assert parse_dictionary_attributes_from_create_dictionary_query(_RANGE_QUERY) == [
        ParsedDictionaryAttribute(name="id", type="UInt64"),
        ParsedDictionaryAttribute(
            name="parent_id", type="UInt64", hierarchical=True, bidirectional=True
        ),
        ParsedDictionaryAttribute(name="start_date", type="DateTime"),
        ParsedDictionaryAttribute(name="end_date", type="DateTime"),
    ]
    assert parse_dictionary_range_from_create_dictionary_query(_RANGE_QUERY) == (
        "start_date",
        "end_date",
    )
    assert parse_dictionary_settings_from_create_dictionary_query(_RANGE_QUERY) == {
        "dictionary_use_async_executor": 1,
        "max_threads": 8,
    }


def test_range_and_settings_return_none_when_absent() -> None:
    assert parse_dictionary_range_from_create_dictionary_query(_PARSER_QUERY) is None
    assert parse_dictionary_settings_from_create_dictionary_query(_PARSER_QUERY) is None
    assert parse_dictionary_range_from_create_dictionary_query(None) is None
    assert parse_dictionary_settings_from_create_dictionary_query(None) is None


def test_expression_calling_range_function_does_not_shadow_real_range_clause() -> None:
    # `range(...)` is a real ClickHouse array function, so it can legitimately
    # appear inside an attribute's EXPRESSION. The parser must not mistake it
    # for the dictionary-level RANGE(MIN ... MAX ...) clause.
    shadowed = """CREATE DICTIONARY default.rates_dict
(
  `id` UInt64,
  `buckets` String EXPRESSION arrayStringConcat(arrayMap(x -> toString(x), range(1, 10)), ','),
  `start_date` DateTime,
  `end_date` DateTime
)
PRIMARY KEY id
SOURCE(HTTP(url 'http://example.com/rates' format 'TSV'))
LAYOUT(RANGE_HASHED())
LIFETIME(MIN 0 MAX 300)
RANGE(MIN start_date MAX end_date)"""
    assert parse_dictionary_attributes_from_create_dictionary_query(shadowed) == [
        ParsedDictionaryAttribute(name="id", type="UInt64"),
        ParsedDictionaryAttribute(
            name="buckets",
            type="String",
            expression=(
                "arrayStringConcat(arrayMap(x -> toString(x), range(1, 10)), ',')"
            ),
        ),
        ParsedDictionaryAttribute(name="start_date", type="DateTime"),
        ParsedDictionaryAttribute(name="end_date", type="DateTime"),
    ]
    assert parse_dictionary_range_from_create_dictionary_query(shadowed) == (
        "start_date",
        "end_date",
    )
    assert parse_source_from_create_dictionary_query(shadowed) == (
        "HTTP(url 'http://example.com/rates' format 'TSV')"
    )


# ---------- safety markers ----------


def test_synthesizes_danger_marker_for_handwritten_drop_dictionary() -> None:
    sql = "DROP DICTIONARY default.users_dict;"
    markers = collect_unmarked_destructive_statements("20260101_handwritten.sql", sql)
    assert len(markers) == 1
    marker = markers[0]
    assert marker.type == "drop_dictionary"
    assert marker.risk == "danger"
    assert marker.key == "default.users_dict"
    assert marker.warning_code == "drop_dictionary_dependency_break"
    assert "DROP DICTIONARY" in marker.summary


def test_planner_emitted_drop_dictionary_gets_dependency_break_warning() -> None:
    sql = "\n".join(
        [
            "-- operation: drop_dictionary key=dictionary:default.users_dict risk=danger",
            "DROP DICTIONARY IF EXISTS default.users_dict;",
        ]
    )
    markers = collect_destructive_operation_markers("20260101_drop_dict.sql", sql)
    assert len(markers) == 1
    assert markers[0].type == "drop_dictionary"
    assert markers[0].warning_code == "drop_dictionary_dependency_break"


# ---------- drift: object existence ----------


def test_dictionary_treated_like_other_kinds_for_existence_drift() -> None:
    result = compare_schema_objects(
        [SchemaObjectShape(kind="dictionary", database="app", name="users_dict")],
        [],
    )
    assert result.missing == ["dictionary:app.users_dict"]
    assert any(
        d.code == "missing_object"
        and d.object == "dictionary:app.users_dict"
        and d.expected_kind == "dictionary"
        for d in result.object_drift
    )


def test_no_drift_when_dictionary_exists_on_both_sides() -> None:
    shape = SchemaObjectShape(kind="dictionary", database="app", name="users_dict")
    result = compare_schema_objects([shape], [shape])
    assert result.missing == []
    assert result.extra == []
    assert result.object_drift == []


# ---------- rename pipeline (TS generate.e2e.test.ts, pipeline level) ----------


def _rename_pipeline_plan(
    old_name: str,
    new_name: str,
    *,
    renamed_from: dict[str, str] | None = None,
    cli_mappings: list[str] | None = None,
) -> Any:
    """Run the generate rename pipeline the way `chkit generate` composes it."""
    old_defs = [_dict(name=old_name)]
    new_kwargs: dict[str, Any] = {"name": new_name}
    if renamed_from is not None:
        new_kwargs["renamed_from"] = renamed_from
    new_defs = [_dict(**new_kwargs)]

    cli = parse_rename_dictionary_mappings(cli_mappings or [])
    schema_mappings = collect_schema_rename_mappings(new_defs)
    merged = merge_dictionary_mappings(schema_mappings.dictionary_mappings, cli)
    active = resolve_active_dictionary_mappings(old_defs, new_defs, merged)
    remapped_old = remap_old_definitions_for_dictionary_renames(old_defs, active)
    plan = plan_diff(remapped_old, new_defs)
    return apply_explicit_dictionary_renames(plan, active)


def test_cli_rename_dictionary_emits_rename_not_drop_create() -> None:
    plan = _rename_pipeline_plan(
        "users_dict",
        "lookup_dict",
        cli_mappings=["app.users_dict=app.lookup_dict"],
    )
    types = [op.type for op in plan.operations]
    assert "rename_dictionary" in types
    rename_op = next(op for op in plan.operations if op.type == "rename_dictionary")
    assert (
        rename_op.sql
        == "RENAME DICTIONARY IF EXISTS app.users_dict TO app.lookup_dict;"
    )
    assert "drop_dictionary" not in types
    assert "create_dictionary" not in types


def test_schema_renamed_from_emits_explicit_rename_dictionary() -> None:
    plan = _rename_pipeline_plan(
        "users_dict",
        "lookup_dict",
        renamed_from={"name": "users_dict"},
    )
    types = [op.type for op in plan.operations]
    assert "rename_dictionary" in types
    assert "drop_dictionary" not in types
    assert "create_dictionary" not in types


# ---------- password warnings (generate + pull) ----------


def test_generate_warns_on_plain_text_dictionary_password() -> None:
    plan = plan_diff([], [_dict()])
    warnings = detect_dictionary_password_warnings(plan)
    assert any("app.users_dict" in w and "plain text" in w for w in warnings)


def test_generate_does_not_warn_on_hidden_placeholder_password() -> None:
    plan = plan_diff(
        [],
        [_dict(source="MYSQL(host 'db' user 'reader' password '[HIDDEN]' table 'users')")],
    )
    assert detect_dictionary_password_warnings(plan) == []


def test_pull_warns_on_hidden_and_plain_text_passwords() -> None:
    hidden = _dict(
        source="MYSQL(host 'db' user 'reader' password '[HIDDEN]' table 'users')"
    )
    plain = _dict(name="other_dict")
    warnings = _dictionary_password_warnings([hidden, plain])
    assert len(warnings) == 2
    assert "redacted by ClickHouse" in warnings[0]
    assert "plain-text password" in warnings[1]


# ---------- pull render ----------


def test_pull_render_emits_dictionary_definition() -> None:
    content = render_schema_file([_dict()])
    assert "from chkit import" in content
    assert "dictionary" in content.split("\n")[2]
    assert 'database="app"' in content
    assert 'name="users_dict"' in content
    assert 'DictionaryAttribute(name="id", type="UInt64")' in content
    assert 'layout="HASHED()"' in content


def test_pull_render_adds_hidden_note_for_redacted_password() -> None:
    content = render_schema_file(
        [_dict(source="MYSQL(host 'db' password '[HIDDEN]' table 'users')")]
    )
    assert "password redacted by ClickHouse" in content


# ---------- codegen ----------


def test_codegen_renders_dictionary_model_even_without_include_views() -> None:
    output = generate_type_artifacts(
        definitions=[_dict()], options={"includeViews": False}
    )
    assert "class AppUsersDictRow(BaseModel):" in output.content
    assert "id: str" in output.content or "id: int" in output.content
    assert "email: str" in output.content


# ---------- JS Number() coercion parity in the parser ----------


def test_settings_values_coerce_with_js_number_semantics() -> None:
    def settings_for(value: str) -> dict[str, str | int | float] | None:
        query = (
            "CREATE DICTIONARY d.x (`id` UInt64) PRIMARY KEY id "
            "SOURCE(HTTP(url 'http://e' format 'TSV')) LAYOUT(FLAT()) "
            f"LIFETIME(300) SETTINGS(k = {value})"
        )
        return parse_dictionary_settings_from_create_dictionary_query(query)

    assert settings_for("300") == {"k": 300}
    # JS Number('300.0') is the integer-valued 300, rendered without '.0'.
    assert settings_for("300.0") == {"k": 300}
    assert settings_for("1e5") == {"k": 100000}
    assert settings_for("1.5") == {"k": 1.5}
    assert settings_for("0x1A") == {"k": 26}
    # Python-only numeric spellings must stay strings, as in JS.
    assert settings_for("1_000") == {"k": "1_000"}
    assert settings_for("nan") == {"k": "nan"}
    assert settings_for("inf") == {"k": "inf"}
    assert settings_for("Infinity") == {"k": "Infinity"}
