"""Tests for `chkit.cli.migration_metadata.extract_migration_metadata`."""

from __future__ import annotations

from chkit.cli.migration_metadata import (
    KNOWN_KEYS,
    MigrationMetadata,
    extract_migration_metadata,
)


def test_returns_empty_for_no_header() -> None:
    assert extract_migration_metadata("CREATE TABLE t (id UInt64);") == MigrationMetadata()


def test_extracts_log_header() -> None:
    sql = "-- log: Backfill kicks off after this\n\nCREATE TABLE t (id UInt64);"
    assert extract_migration_metadata(sql) == MigrationMetadata(log="Backfill kicks off after this")


def test_log_is_case_insensitive_key() -> None:
    sql = "-- LOG: Hello\n\nCREATE TABLE t (id UInt64);"
    assert extract_migration_metadata(sql).log == "Hello"


def test_first_occurrence_wins() -> None:
    sql = "-- log: first\n-- log: second\n\nCREATE TABLE t (id UInt64);"
    assert extract_migration_metadata(sql).log == "first"


def test_unknown_keys_ignored() -> None:
    sql = "-- foo: bar\n-- log: keep\n\nCREATE TABLE t (id UInt64);"
    assert extract_migration_metadata(sql).log == "keep"


def test_stops_at_first_non_comment_line() -> None:
    sql = "-- log: pre\nCREATE TABLE t (id UInt64);\n-- log: post"
    assert extract_migration_metadata(sql).log == "pre"


def test_blank_lines_inside_header_are_skipped() -> None:
    sql = "\n\n-- log: after-blanks\n\nCREATE TABLE t (id UInt64);"
    assert extract_migration_metadata(sql).log == "after-blanks"


def test_malformed_line_is_ignored_but_does_not_stop_parsing() -> None:
    sql = "-- not a valid key=value pair\n-- log: still parsed\n"
    assert extract_migration_metadata(sql).log == "still parsed"


def test_value_trimmed_of_surrounding_whitespace() -> None:
    sql = "-- log:    spaced  \n"
    assert extract_migration_metadata(sql).log == "spaced"


def test_known_keys_only_contains_documented_keys() -> None:
    # Regression: keep this in sync with the TS side. If TS adds new keys,
    # extend KNOWN_KEYS and add a test case here.
    assert {"log"} == KNOWN_KEYS
