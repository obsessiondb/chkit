"""Port of the TS ``create-table-columns.test.ts``."""

from __future__ import annotations

import pytest

from chkit.cli.create_table_columns import create_table_element_names

# Renderings of the same journal under show_create_query_identifier_quoting_style
# and _rule, as ClickHouse 26.8 prints them in system.tables.create_table_query.
BACKTICKS = (
    "CREATE TABLE db._chkit_migrations (`name` String, `operations` "
    "Array(Tuple(operation_index Int32, last_error String)) DEFAULT [], "
    "`operation_fingerprints` Array(String) DEFAULT [] COMMENT 'x', `a b` UInt8) "
    "ENGINE = SharedMergeTree ORDER BY name SETTINGS index_granularity = 1"
)
DOUBLE_QUOTES = (
    'CREATE TABLE "db"."_chkit_migrations" ("name" String, "operations" '
    "Array(Tuple(operation_index Int32, last_error String)) DEFAULT [], "
    '"operation_fingerprints" Array(String) DEFAULT [] COMMENT \'x\', "a b" UInt8) '
    'ENGINE = SharedMergeTree ORDER BY "name"'
)
BARE = (
    "CREATE TABLE db._chkit_migrations (`name` String, operations "
    "Array(Tuple(operation_index Int32, last_error String)) DEFAULT [], "
    "operation_fingerprints Array(String) DEFAULT [] COMMENT 'x', `a b` UInt8) "
    "ENGINE = SharedMergeTree ORDER BY `name`"
)


@pytest.mark.parametrize("sql", [BACKTICKS, DOUBLE_QUOTES, BARE], ids=["backticks", "double_quotes", "bare"])
def test_reads_the_column_names_whatever_the_identifier_quoting(sql: str) -> None:
    assert create_table_element_names(sql) == ["name", "operations", "operation_fingerprints", "a b"]


def test_a_comment_default_or_string_that_mentions_a_name_does_not_define_it() -> None:
    sql = (
        "CREATE TABLE db.j (`name` String COMMENT 'operation_fingerprints, "
        "`operation_fingerprints` Array(String)', `x` String DEFAULT "
        "'a,\\'operation_fingerprints\\'' /* , operation_fingerprints Array(String) */) "
        "ENGINE = MergeTree ORDER BY name COMMENT 'operation_fingerprints'"
    )
    assert create_table_element_names(sql) == ["name", "x"]


def test_names_an_index_projection_or_constraint_too() -> None:
    assert create_table_element_names(
        "CREATE TABLE db.j (`name` String, INDEX operation_fingerprints name TYPE minmax, "
        "PROJECTION p (SELECT name), CONSTRAINT c CHECK 1) ENGINE = MergeTree ORDER BY name"
    ) == ["name", "INDEX", "operation_fingerprints", "PROJECTION", "p", "CONSTRAINT", "c"]


def test_unescapes_quoted_names() -> None:
    assert create_table_element_names(
        'CREATE TABLE db.j (`a``b` String, "c\\"d" String, `e\\`f` String) ENGINE = Log'
    ) == ["a`b", 'c"d', "e`f"]


@pytest.mark.parametrize(
    "sql",
    [
        "",
        "CREATE TABLE db.j ENGINE = Log",
        "CREATE TABLE db.j (`name` String",
        "CREATE TABLE db.j (`name` String COMMENT 'x) ENGINE = Log",
        "CREATE TABLE db.j () ENGINE = Log",
        "CREATE TABLE db.j (, `name` String) ENGINE = Log",
        "CREATE TABLE db.j (`name String) ENGINE = Log",
        "CREATE TABLE db.j (`name` String /* x) ENGINE = Log",
    ],
)
def test_cannot_read_a_statement_without_a_closed_column_list(sql: str) -> None:
    assert create_table_element_names(sql) is None
