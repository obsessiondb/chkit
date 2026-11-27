"""The splitter returns the same statements as TS (#486).

``test/fixtures/sql-splitter.json`` is shared with
``packages/core/src/sql-splitter.test.ts``: both ports must split each input
into the same statements, ``--`` comments stripped and the ``;`` kept.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from chkit.cli.safety_markers import extract_migration_operation_summaries
from chkit.core.sql_splitter import (
    ExecutableStatementWithComments,
    extract_executable_statements,
    extract_executable_statements_with_comments,
    extract_legacy_executable_statements,
)

FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[2] / "test/fixtures/sql-splitter.json").read_text(
        encoding="utf-8"
    )
)


def _render(text: str) -> str:
    return text.replace("{database}", "app").replace("{table}", "events")


def test_splits_a_migration_file_with_markers_strings_a_heredoc_and_comments() -> None:
    migration = FIXTURE["migration"]
    assert extract_executable_statements(_render(migration["sql"])) == [
        _render(statement) for statement in migration["statements"]
    ]


def test_operation_markers_are_still_read_from_the_file() -> None:
    summaries = extract_migration_operation_summaries(_render(FIXTURE["migration"]["sql"]))
    assert [(s.type, s.key) for s in summaries] == [
        ("create_table", "table:app.events"),
        ("alter_table_add_column", "table:app.events:column:extra"),
    ]


@pytest.mark.parametrize(
    ("sql", "statements"),
    [pytest.param(case["sql"], case["statements"], id=case["name"]) for case in FIXTURE["cases"]],
)
def test_shared_cases(sql: str, statements: list[str]) -> None:
    assert extract_executable_statements(sql) == statements
    # The markers of each statement are read with the same split (#831).
    assert [s.sql for s in extract_executable_statements_with_comments(sql)] == statements


def test_statements_with_comments_group_the_comment_lines_before_each_statement() -> None:
    sql = "\n".join(
        [
            "-- header",
            "",
            "-- operation: a",
            "-- before-retry: x",
            "SELECT 1; -- after SQL",
            "/* block */",
            "-- operation: b",
            "SELECT",
            "-- inside",
            "2;",
            "-- trailing",
        ]
    )
    assert extract_executable_statements_with_comments(sql) == [
        ExecutableStatementWithComments(
            sql="SELECT 1;",
            comment_blocks=[["-- header", "-- operation: a", "-- before-retry: x"]],
            leading_blocks=[["-- header", "-- operation: a", "-- before-retry: x"]],
        ),
        ExecutableStatementWithComments(
            sql="/* block */\n\nSELECT\n\n2;",
            comment_blocks=[["-- operation: b"], ["-- inside"]],
            leading_blocks=[],
        ),
    ]


def test_leading_blocks_are_those_only_whitespace_separates_from_the_statement() -> None:
    # #888, same case as the TS test.
    sql = "SELECT 1;\n-- leading\n  SELECT\n-- inside\n2;\n-- cut off\n/* x */;\n-- kept\nSELECT 3"
    assert extract_executable_statements_with_comments(sql) == [
        ExecutableStatementWithComments(sql="SELECT 1;"),
        ExecutableStatementWithComments(
            sql="SELECT\n\n2;",
            comment_blocks=[["-- leading"], ["-- inside"]],
            leading_blocks=[["-- leading"]],
        ),
        ExecutableStatementWithComments(
            sql="SELECT 3;",
            comment_blocks=[["-- cut off"], ["-- kept"]],
            leading_blocks=[["-- kept"]],
        ),
    ]


# The split before #562, which resume compares against: ``legacyStatements``
# where it differs from ``statements``.
@pytest.mark.parametrize(
    ("sql", "statements"),
    [
        pytest.param(sql_case["sql"], sql_case.get("legacyStatements", sql_case["statements"]), id=sql_case["name"])
        for sql_case in FIXTURE["cases"]
    ],
)
def test_shared_cases_legacy(sql: str, statements: list[str]) -> None:
    assert extract_legacy_executable_statements(sql) == statements
