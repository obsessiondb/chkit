"""Tests for `chkit.cli.safety_markers`."""

from __future__ import annotations

import pytest

from chkit.cli.safety_markers import (
    DestructiveOperationMarker,
    NonSelectBarrier,
    ScannedDestructiveStatement,
    collect_destructive_operation_markers,
    collect_unmarked_destructive_statements,
    extract_executable_statements,
    extract_migration_operation_summaries,
    find_non_select_barriers,
    is_select_statement,
    migration_contains_danger_operation,
    migration_contains_destructive_sql,
    scan_destructive_sql_statements,
)

# ---------- extract_migration_operation_summaries ----------


def test_extract_summaries_keeps_a_key_with_spaces_so_later_operations_stay_aligned() -> None:
    sql = """
      -- operation: create_table key=table:app.my events risk=safe
      CREATE TABLE app.`my events` (id UInt64) ENGINE = MergeTree() ORDER BY id;
      -- operation: create_view key=view:app.v1 risk=safe
      CREATE VIEW app.v1 AS SELECT id FROM app.`my events`;
    """
    # migrate pairs the n-th summary with the n-th statement; a summary lost to
    # the space would make it wait for v1 right after creating the table (#231).
    assert [
        f"{op.type} {op.key} {op.risk}" for op in extract_migration_operation_summaries(sql)
    ] == ["create_table table:app.my events safe", "create_view view:app.v1 safe"]


def test_extract_summaries_returns_empty_for_no_markers() -> None:
    sql = "CREATE TABLE t (id UInt64);"
    assert extract_migration_operation_summaries(sql) == []


def test_extract_summaries_parses_basic_marker() -> None:
    sql = "-- operation: create_table key=table:db.t risk=safe\nCREATE TABLE t (id UInt64);"
    [summary] = extract_migration_operation_summaries(sql)
    assert summary.type == "create_table"
    assert summary.key == "table:db.t"
    assert summary.risk == "safe"
    assert summary.mode == "sync"
    assert summary.before_retry is None


def test_extract_summaries_recognises_mode_async() -> None:
    sql = "-- operation: alter_table_modify_column key=table:db.t:c risk=caution mode=async\nALTER ...;"
    [summary] = extract_migration_operation_summaries(sql)
    assert summary.mode == "async"


def test_extract_summaries_picks_up_before_retry_line() -> None:
    sql = (
        "-- operation: alter_table_modify_column key=table:db.t:c risk=caution\n"
        "-- before-retry: TRUNCATE TABLE db.t;\n"
        "ALTER TABLE db.t ...;"
    )
    [summary] = extract_migration_operation_summaries(sql)
    assert summary.before_retry == "TRUNCATE TABLE db.t"


def test_extract_summaries_skips_before_retry_after_executable_sql() -> None:
    sql = (
        "-- operation: create_table key=table:db.t risk=safe\n"
        "CREATE TABLE t (id UInt64);\n"
        "-- before-retry: TRUNCATE TABLE db.t;"
    )
    [summary] = extract_migration_operation_summaries(sql)
    assert summary.before_retry is None


def test_extract_summaries_handles_multiple_operations() -> None:
    sql = (
        "-- operation: create_table key=table:db.a risk=safe\nCREATE TABLE a (id UInt64);\n"
        "\n"
        "-- operation: create_table key=table:db.b risk=safe\nCREATE TABLE b (id UInt64);"
    )
    summaries = extract_migration_operation_summaries(sql)
    assert [s.key for s in summaries] == ["table:db.a", "table:db.b"]


def test_extract_summaries_drops_malformed_lines() -> None:
    sql = "-- operation: garbage data\nCREATE TABLE t (id UInt64);"
    assert extract_migration_operation_summaries(sql) == []


# ---------- migration_contains_danger_operation ----------


def test_danger_op_detection_positive() -> None:
    sql = "-- operation: drop_table key=table:db.t risk=danger\nDROP TABLE t;"
    assert migration_contains_danger_operation(sql) is True


def test_danger_op_detection_negative_when_marker_safe() -> None:
    sql = "-- operation: create_table key=table:db.t risk=safe\nCREATE TABLE t (id UInt64);"
    assert migration_contains_danger_operation(sql) is False


def test_danger_op_detection_negative_when_no_markers() -> None:
    sql = "DROP TABLE t;"
    assert migration_contains_danger_operation(sql) is False


# ---------- collect_destructive_operation_markers ----------


def test_collect_destructive_markers_for_drop_table() -> None:
    sql = "-- operation: drop_table key=table:db.t risk=danger\nDROP TABLE t;"
    [marker] = collect_destructive_operation_markers("m1.sql", sql)
    assert isinstance(marker, DestructiveOperationMarker)
    assert marker.type == "drop_table"
    assert marker.warning_code == "drop_table_data_loss"
    assert marker.migration == "m1.sql"


def test_collect_destructive_markers_detects_table_recreate() -> None:
    sql = (
        "-- operation: drop_table key=table:db.t risk=danger\nDROP TABLE t;\n"
        "-- operation: create_table key=table:db.t risk=safe\nCREATE TABLE t (id UInt64);"
    )
    [marker] = collect_destructive_operation_markers("m1.sql", sql)
    assert marker.warning_code == "table_recreate_data_loss"
    assert "ALL ROWS are permanently deleted" in marker.impact


def test_collect_destructive_markers_for_drop_column() -> None:
    sql = "-- operation: alter_table_drop_column key=table:db.t:x risk=danger\nALTER TABLE t DROP COLUMN x;"
    [marker] = collect_destructive_operation_markers("m.sql", sql)
    assert marker.warning_code == "drop_column_irreversible"


def test_collect_destructive_markers_for_drop_view() -> None:
    sql = "-- operation: drop_view key=view:db.v risk=danger\nDROP VIEW v;"
    [marker] = collect_destructive_operation_markers("m.sql", sql)
    assert marker.warning_code == "drop_view_dependency_break"


def test_collect_destructive_markers_for_drop_materialized_view() -> None:
    sql = "-- operation: drop_materialized_view key=view:db.v risk=danger\nDROP MATERIALIZED VIEW v;"
    [marker] = collect_destructive_operation_markers("m.sql", sql)
    assert marker.warning_code == "drop_view_dependency_break"


def test_collect_destructive_markers_default_warning_for_unknown_type() -> None:
    sql = "-- operation: weird_destructive key=table:db.t risk=danger\nDO_WEIRD_THING;"
    [marker] = collect_destructive_operation_markers("m.sql", sql)
    assert marker.warning_code == "destructive_operation_review_required"


# ---------- scan_destructive_sql_statements ----------


def test_scan_detects_unmarked_drop_table() -> None:
    sql = "DROP TABLE db.t;"
    [stmt] = scan_destructive_sql_statements(sql)
    assert isinstance(stmt, ScannedDestructiveStatement)
    assert stmt.type == "drop_table"


def test_scan_detects_unmarked_truncate() -> None:
    sql = "TRUNCATE TABLE db.t;"
    [stmt] = scan_destructive_sql_statements(sql)
    assert stmt.type == "truncate_table"


def test_scan_detects_unmarked_detach() -> None:
    sql = "DETACH TABLE db.t;"
    [stmt] = scan_destructive_sql_statements(sql)
    assert stmt.type == "detach"


def test_scan_detects_unmarked_drop_column() -> None:
    sql = "ALTER TABLE db.t DROP COLUMN x;"
    [stmt] = scan_destructive_sql_statements(sql)
    assert stmt.type == "alter_table_drop_column"


def test_scan_does_not_flag_truncate_function_call() -> None:
    # Statement does NOT include the noun keyword TABLE/DATABASE/ALL TABLES.
    sql = "SELECT truncate(x, 2) FROM t;"
    assert scan_destructive_sql_statements(sql) == []


def test_scan_skips_marker_covered_position() -> None:
    sql = (
        "-- operation: drop_table key=table:db.t risk=safe\n"
        "DROP TABLE t;"
    )
    # Marker present → trusted to planner classification, not flagged.
    assert scan_destructive_sql_statements(sql) == []


def test_scan_flags_extra_unmarked_statement() -> None:
    sql = (
        "-- operation: create_table key=table:db.a risk=safe\nCREATE TABLE a (id UInt64);\n"
        "DROP TABLE b;"  # extra, no marker
    )
    [stmt] = scan_destructive_sql_statements(sql)
    assert stmt.type == "drop_table"


def test_scan_ignores_commented_destructive() -> None:
    sql = "-- DROP TABLE t;\nCREATE TABLE u (id UInt64);"
    assert scan_destructive_sql_statements(sql) == []


# #642: every comment form ClickHouse reads, plus string literals and quoted
# names, is text the scan must not read as SQL.
@pytest.mark.parametrize(
    "sql",
    [
        "// DROP TABLE default.events\nSELECT 1;",
        "# DROP TABLE default.events\nSELECT 1;",
        "#! DROP TABLE default.events\nSELECT 1;",
        "/* DROP TABLE default.events */ SELECT 1;",
        "/* a /* b */ TRUNCATE TABLE default.events */ SELECT 1;",
        "SELECT 1 // DROP TABLE default.events\n;",
        "INSERT INTO default.log VALUES ('DROP TABLE default.events');",
        "SELECT $x$DETACH TABLE default.events$x$;",
        "SELECT 1 AS `DROP TABLE default.events`;",
        'SELECT 1 AS "ALTER TABLE t DROP COLUMN c";',
    ],
)
def test_scan_ignores_destructive_text_in_comments_strings_and_names(sql: str) -> None:
    assert scan_destructive_sql_statements(sql) == []


@pytest.mark.parametrize(
    ("sql", "type_", "key"),
    [
        ("DROP /* hand-written */ TABLE default.events;", "drop_table", "default.events"),
        ("DROP/**/TABLE default.events;", "drop_table", "default.events"),
        (
            "ALTER TABLE default.events DROP // why\nCOLUMN email;",
            "alter_table_drop_column",
            "default.events",
        ),
        ("TRUNCATE # all of it\nTABLE default.events;", "truncate_table", "default.events"),
        ("// cleanup\nDROP TABLE default.events;", "drop_table", "default.events"),
        ("/* TABLE default.wrong */ DROP TABLE default.events;", "drop_table", "default.events"),
        ("DROP TABLE default.events /* 'x */ -- y\n;", "drop_table", "default.events"),
        ("DETACH TABLE `events`;", "detach", "events"),
        # ClickHouse reads U+2018...U+2019 as a string, so the ASCII quotes inside
        # are text; the chkit lexer does not, and pairs them across the DROP.
        (
            "ALTER TABLE t COMMENT COLUMN x \u2018it's\u2019, DROP COLUMN y, COMMENT COLUMN z \u2018it's\u2019;",
            "alter_table_drop_column",
            "t",
        ),
        ("ALTER TABLE t COMMENT COLUMN x \u2018/*\u2019, DROP COLUMN y;", "alter_table_drop_column", "t"),
    ],
)
def test_scan_flags_destructive_statement_around_comments(sql: str, type_: str, key: str) -> None:
    markers = collect_unmarked_destructive_statements("20260101_handwritten.sql", sql)
    assert [(m.type, m.key) for m in markers] == [(type_, key)]


def test_scan_flags_only_the_real_statement_after_a_commented_out_one() -> None:
    sql = (
        "SELECT 1 /* DROP TABLE default.a */; # DROP TABLE default.b\n"
        "TRUNCATE TABLE default.events;"
    )
    found = scan_destructive_sql_statements(sql)
    assert [f.type for f in found] == ["truncate_table"]
    assert found[0].statement == "# DROP TABLE default.b\nTRUNCATE TABLE default.events;"


def test_migration_contains_destructive_sql_helper() -> None:
    assert migration_contains_destructive_sql("DROP TABLE t;") is True
    assert migration_contains_destructive_sql("CREATE TABLE t (id UInt64);") is False


# ---------- collect_unmarked_destructive_statements ----------


def test_unmarked_yields_synthesized_markers() -> None:
    sql = "DROP TABLE db.events;"
    [marker] = collect_unmarked_destructive_statements("m.sql", sql)
    assert marker.risk == "danger"
    assert marker.type == "drop_table"
    assert marker.key == "db.events"
    assert "unmarked destructive SQL" in marker.summary


def test_unmarked_truncates_long_previews() -> None:
    long_stmt = "DROP TABLE " + ("x" * 200)
    sql = long_stmt + ";"
    [marker] = collect_unmarked_destructive_statements("m.sql", sql)
    assert marker.summary.endswith("...")


def test_unmarked_key_extracts_db_table() -> None:
    sql = "TRUNCATE TABLE analytics.events;"
    [marker] = collect_unmarked_destructive_statements("m.sql", sql)
    assert marker.key == "analytics.events"


# ---------- is_select_statement / find_non_select_barriers (#634) ----------


@pytest.mark.parametrize(
    "statement",
    [
        "SELECT query_id FROM system.processes WHERE query_kind IN ('Insert', 'AsyncInsertFlush');",
        "select 1",
        "  /* note */ -- line\n( (SELECT 1) ) UNION ALL (SELECT 2);",
        "// note\nWITH 1 AS x SELECT x;",
        "# note\nWITH x AS (SELECT 1), y AS (SELECT 2) SELECT * FROM x;",
        "WITH (SELECT 1) AS x SELECT x",
        "(WITH 1 AS x SELECT x);",
        "WITH 1 AS x SELECT `insert` FROM t",
        "SELECT * FROM (SELECT 1 AS insert, 2 AS parallel)",
        "SELECT query_id FROM system.processes AS insert WHERE query_kind = 'Insert'",
        "WITH 1 AS insert SELECT insert.x FROM t AS insert",
        "FROM system.processes SELECT query_id WHERE query_kind = 'Insert';",
    ],
)
def test_is_select_statement(statement: str) -> None:
    assert is_select_statement(statement)


@pytest.mark.parametrize(
    "statement",
    [
        "CREATE TABLE default.t (id UInt64) ENGINE = MergeTree ORDER BY id;",
        "EXCHANGE TABLES default.a AND default.b;",
        "INSERT INTO default.t SELECT 1;",
        "WITH 1 AS x INSERT INTO default.t SELECT x;",
        "with 1 as x insert into default.t values (1);",
        "(WITH 1 AS x INSERT INTO default.t SELECT x)",
        "SELECT 1 PARALLEL WITH CREATE TABLE default.t (id UInt64) ENGINE = MergeTree ORDER BY id;",
        "(SELECT 1) parallel /* c */ with DROP TABLE default.t",
        "WITH 1 AS x SELECT x PARALLEL WITH DROP TABLE default.t",
        "`SELECT` 1",
        "'SELECT'",
        "EXPLAIN SELECT 1",
        "FROM default.t SELECT 1 PARALLEL WITH DROP TABLE default.t",
        "SHOW PROCESSLIST",
        "/* SELECT */ DROP TABLE default.t",
        "",
    ],
)
def test_is_not_select_statement(statement: str) -> None:
    assert not is_select_statement(statement)


def test_find_non_select_barriers_lists_them_by_position() -> None:
    sql = "\n".join([
        "-- operation: create_table key=table:default.a risk=safe",
        "CREATE TABLE default.a (id UInt64) ENGINE = MergeTree ORDER BY id;",
        "-- operation: cutover_wait_for_inserts key=table:default.a:cutover:mirror_barrier "
        "risk=safe mode=barrier",
        "SELECT query_id FROM system.processes WHERE query_kind = 'Insert';",
        "-- operation: create_table key=table:default.b risk=safe mode=barrier",
        "CREATE TABLE default.b (id UInt64) ENGINE = MergeTree ORDER BY id;",
        "-- operation: exchange_tables key=table:default.a risk=caution mode=barrier",
        "EXCHANGE TABLES default.a AND default.b;",
        "",
    ])
    assert find_non_select_barriers(
        extract_executable_statements(sql), extract_migration_operation_summaries(sql)
    ) == [
        NonSelectBarrier(
            index=2,
            statement="CREATE TABLE default.b (id UInt64) ENGINE = MergeTree ORDER BY id;",
            summary="create_table key=table:default.b risk=safe mode=barrier",
        ),
        NonSelectBarrier(
            index=3,
            statement="EXCHANGE TABLES default.a AND default.b;",
            summary="exchange_tables key=table:default.a risk=caution mode=barrier",
        ),
    ]


def test_find_non_select_barriers_ignores_other_modes() -> None:
    sql = (
        "-- operation: create_table key=table:default.a risk=safe mode=async\n"
        "CREATE TABLE default.a (id UInt64) ENGINE = MergeTree ORDER BY id;\n"
        "DROP TABLE default.b;\n"
    )
    assert find_non_select_barriers(
        extract_executable_statements(sql), extract_migration_operation_summaries(sql)
    ) == []
