"""#767 (Opus review): only a SELECT or an INSERT applies nothing before its
pipeline starts; every other statement, and one that cannot be told, may."""

from __future__ import annotations

import pytest

from chkit.cli.safety_markers import rejection_runs_nothing


@pytest.mark.parametrize(
    "statement",
    [
        "SELECT 1",
        "(SELECT 1)",
        "WITH x AS (SELECT 1) SELECT * FROM x",
        "INSERT INTO t SELECT * FROM s",
        "INSERT INTO t VALUES (1, 'a')",
        "-- a comment\ninsert into t select 1",
        "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
    ],
)
def test_a_select_or_an_insert_runs_nothing_when_rejected(statement: str) -> None:
    assert rejection_runs_nothing(statement)


@pytest.mark.parametrize(
    "statement",
    [
        "ALTER TABLE t UPDATE v = v + 100 WHERE 1",
        "ALTER TABLE t DELETE WHERE 1",
        "EXCHANGE TABLES a AND b",
        "RENAME TABLE a TO b",
        "OPTIMIZE TABLE t FINAL",
        "CREATE TABLE t (x UInt8) ENGINE = MergeTree ORDER BY x",
        "INSERT INTO t SELECT 1 PARALLEL WITH ALTER TABLE t DELETE WHERE 1",
        "NOT VALID SQL",
        "",
    ],
)
def test_any_other_statement_may_have_applied_effects(statement: str) -> None:
    assert not rejection_runs_nothing(statement)
