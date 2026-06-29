"""Tests for `chkit.cli.safety_markers`."""

from __future__ import annotations

from chkit.cli.safety_markers import (
    DestructiveOperationMarker,
    ScannedDestructiveStatement,
    collect_destructive_operation_markers,
    collect_unmarked_destructive_statements,
    extract_migration_operation_summaries,
    migration_contains_danger_operation,
    migration_contains_destructive_sql,
    scan_destructive_sql_statements,
)

# ---------- extract_migration_operation_summaries ----------


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
