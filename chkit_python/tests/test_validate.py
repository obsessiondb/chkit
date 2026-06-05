"""Validation rule tests."""

from __future__ import annotations

import pytest

from chkit.core.model import (
    ChxValidationError,
    ColumnDefinition,
    MaterializedViewRefresh,
    TableRef,
    materialized_view,
    table,
)
from chkit.core.validate import assert_valid_definitions, validate_definitions


def test_duplicate_columns_is_an_issue() -> None:
    definition = table(
        database="d",
        name="t",
        engine="MergeTree",
        columns=[
            ColumnDefinition(name="x", type="UInt8"),
            ColumnDefinition(name="x", type="UInt8"),
        ],
        primary_key=["x"],
        order_by=["x"],
    )
    issues = validate_definitions([definition])
    assert any(issue.code == "duplicate_column_name" for issue in issues)


def test_primary_key_missing_column_is_an_issue() -> None:
    definition = table(
        database="d",
        name="t",
        engine="MergeTree",
        columns=[ColumnDefinition(name="a", type="UInt8")],
        primary_key=["b"],
        order_by=["a"],
    )
    issues = validate_definitions([definition])
    assert any(issue.code == "primary_key_missing_column" for issue in issues)


def test_assert_valid_raises_for_issues() -> None:
    definition = table(
        database="d",
        name="t",
        engine="MergeTree",
        columns=[
            ColumnDefinition(name="x", type="UInt8"),
            ColumnDefinition(name="x", type="UInt8"),
        ],
        primary_key=["x"],
        order_by=["x"],
    )
    with pytest.raises(ChxValidationError):
        assert_valid_definitions([definition])


def test_refresh_requires_every_or_after() -> None:
    mv = materialized_view(
        database="d",
        name="mv",
        to=TableRef(database="d", name="t"),
        as_="SELECT 1",
        refresh=MaterializedViewRefresh(),
    )
    issues = validate_definitions([mv])
    codes = {issue.code for issue in issues}
    assert "refresh_requires_every_or_after" in codes
