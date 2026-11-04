"""What ``chkit pull`` reads back must plan nothing against the migrated schema (#466)."""

from __future__ import annotations

from typing import Any

import pytest

from chkit.cli.commands.pull import _introspected_table_to_definition, _is_pulled_object
from chkit.clickhouse.introspect import IntrospectedTable
from chkit.core.model import (
    ColumnDefinition,
    DictionaryDefinition,
    TableDefinition,
    dictionary,
    table,
)
from chkit.core.planner import plan_diff


def _events(default: Any = None, settings: dict[str, Any] | None = None) -> TableDefinition:
    column: dict[str, Any] = {"name": "n", "type": "UInt8"}
    if default is not None:
        column["default"] = default
    return table(
        database="app",
        name="events",
        engine="MergeTree()",
        primary_key=["id"],
        order_by=["id"],
        columns=[{"name": "id", "type": "UInt64"}, column],
        settings=settings,
    )


def _lookup(lifetime: str) -> DictionaryDefinition:
    return dictionary(
        database="app",
        name="lookup",
        attributes=[{"name": "k", "type": "UInt64"}, {"name": "v", "type": "String"}],
        primary_key=["k"],
        source="NULL()",
        layout="HASHED()",
        lifetime=lifetime,
    )


def _introspected(name: str, engine: str, settings: dict[str, str]) -> IntrospectedTable:
    return IntrospectedTable(
        database="app",
        name=name,
        columns=[ColumnDefinition(name="id", type="UInt64")],
        settings=settings,
        indexes=[],
        projections=[],
        engine=engine,
        order_by="id",
    )


def test_a_default_that_renders_the_same_clause_plans_nothing() -> None:
    assert plan_diff([_events(7)], [_events({"expression": "7"})]).operations == []
    assert plan_diff([_events("web")], [_events({"expression": "'web'"})]).operations == []
    assert plan_diff([_events({"expression": "7"})], [_events(7)]).operations == []


def test_a_default_that_renders_another_clause_still_plans_a_modify_column() -> None:
    plan = plan_diff([_events(7)], [_events({"expression": "8"})])
    assert [op.sql for op in plan.operations] == [
        "ALTER TABLE app.events MODIFY COLUMN `n` UInt8 DEFAULT 8;"
    ]


def test_a_setting_compares_by_the_value_it_renders() -> None:
    declared = _events(settings={"index_granularity": 4096, "ttl_only_drop_parts": True})
    pulled = _events(settings={"index_granularity": "4096", "ttl_only_drop_parts": "true"})
    assert plan_diff([declared], [pulled]).operations == []
    changed = _events(settings={"index_granularity": "8192", "ttl_only_drop_parts": True})
    assert [op.sql for op in plan_diff([declared], [changed]).operations] == [
        "ALTER TABLE app.events MODIFY SETTING index_granularity = 8192;"
    ]


@pytest.mark.parametrize(
    ("declared", "stored"),
    [
        ("300", "MIN 0 MAX 300"),
        ("MIN 0 MAX 300", "300"),
        ("MAX 300 MIN 10", "MIN 10 MAX 300"),
        ("min 5 max 60", "MIN 5 MAX 60"),
    ],
)
def test_lifetime_forms_clickhouse_stores_the_same_plan_nothing(declared: str, stored: str) -> None:
    assert plan_diff([_lookup(declared)], [_lookup(stored)]).operations == []


def test_a_lifetime_clickhouse_stores_differently_still_replaces_the_dictionary() -> None:
    plan = plan_diff([_lookup("300")], [_lookup("MIN 10 MAX 300")])
    assert [op.type for op in plan.operations] == ["create_dictionary"]
    assert "LIFETIME(MIN 10 MAX 300)" in plan.operations[0].sql


def test_pull_leaves_out_settings_the_server_fills_in() -> None:
    server = {"index_granularity": "8192", "storage_policy": "default"}
    local = _introspected(
        "t", "MergeTree", {"index_granularity": "8192", "merge_with_ttl_timeout": "3600"}
    )
    pulled = _introspected_table_to_definition(local, server)
    assert pulled is not None
    assert pulled.settings == {"merge_with_ttl_timeout": 3600}

    shared = _introspected(
        "t", "SharedMergeTree", {"storage_policy": "'s3'", "index_granularity": "4096"}
    )
    pulled = _introspected_table_to_definition(shared, server)
    assert pulled is not None
    assert pulled.settings == {"index_granularity": 4096}

    # storage_policy 's3' is only implied on a Shared table.
    plain = _introspected("t", "MergeTree", {"storage_policy": "'s3'"})
    pulled = _introspected_table_to_definition(plain, server)
    assert pulled is not None
    assert pulled.settings == {"storage_policy": "'s3'"}


def test_pull_leaves_out_the_journal_table(monkeypatch: pytest.MonkeyPatch) -> None:
    def table_named(name: str) -> TableDefinition:
        return table(
            database="app", name=name, engine="MergeTree()", primary_key=["id"],
            order_by=["id"], columns=[{"name": "id", "type": "UInt64"}],
        )

    monkeypatch.delenv("CHKIT_JOURNAL_TABLE", raising=False)
    assert not _is_pulled_object(table_named("_chkit_migrations"))
    assert _is_pulled_object(table_named("events"))
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", "app_journal")
    assert not _is_pulled_object(table_named("app_journal"))
    assert _is_pulled_object(table_named("_chkit_migrations"))
