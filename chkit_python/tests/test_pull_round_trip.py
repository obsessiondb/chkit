"""What ``chkit pull`` reads back must plan nothing against the migrated schema (#466)."""

from __future__ import annotations

from typing import Any

import pytest

from chkit.cli.commands.pull import _introspected_table_to_definition, _is_pulled_object
from chkit.cli.commands.pull_render import render_schema_file
from chkit.clickhouse.introspect import IntrospectedTable
from chkit.core.model import (
    ColumnDefinition,
    DictionaryDefinition,
    TableDefinition,
    dictionary,
    table,
)
from chkit.core.planner import plan_diff


def _events(
    default: Any = None,
    settings: dict[str, Any] | None = None,
    indexes: list[dict[str, Any]] | None = None,
) -> TableDefinition:
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
        indexes=indexes,
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


@pytest.mark.parametrize(
    ("declared", "stored"),
    [
        ("it's", "'it\\'s'"),
        ("x\ny", "'x\\ny'"),
        ("x\ty", "'x\\ty'"),
        ("back\\slash", "'back\\\\slash'"),
        (2.0, "2."),
        (2.5, "2.5"),
    ],
)
def test_a_literal_default_compares_by_value_with_the_stored_escapes(
    declared: Any, stored: str
) -> None:
    pulled = _events({"expression": stored})
    assert plan_diff([_events(declared)], [pulled]).operations == []
    assert plan_diff([pulled], [_events(declared)]).operations == []


def test_a_literal_default_with_another_value_still_plans_a_change() -> None:
    assert len(plan_diff([_events("it's")], [_events({"expression": "'its'"})]).operations) == 1
    assert len(plan_diff([_events(2)], [_events({"expression": "'2'"})]).operations) == 1


def test_a_default_that_renders_another_clause_still_plans_a_modify_column() -> None:
    plan = plan_diff([_events(7)], [_events({"expression": "8"})])
    assert [op.sql for op in plan.operations] == [
        "ALTER TABLE app.events MODIFY COLUMN `n` UInt8 DEFAULT 8;"
    ]


def test_a_setting_compares_by_its_value_in_the_forms_clickhouse_stores() -> None:
    declared = _events(
        settings={
            "merge_selecting_sleep_slowdown_factor": 2.0,
            "min_bytes_for_wide_part": 1e6,
            "ttl_only_drop_parts": True,
        }
    )
    pulled = _events(
        settings={
            "index_granularity": "8192",
            "merge_selecting_sleep_slowdown_factor": "2.",
            "min_bytes_for_wide_part": "1000000.",
            "ttl_only_drop_parts": "true",
        }
    )
    assert plan_diff([declared], [pulled]).operations == []
    assert plan_diff([pulled], [declared]).operations == []


def test_a_merge_tree_table_without_index_granularity_has_the_8192_clickhouse_stores() -> None:
    assert plan_diff([_events()], [_events(settings={"index_granularity": "8192"})]).operations == []
    assert plan_diff([_events(settings={"index_granularity": 8192})], [_events()]).operations == []
    created = next(op for op in plan_diff([], [_events()]).operations if op.type == "create_table")
    assert created.sql.endswith("SETTINGS index_granularity = 8192;")


def test_an_editable_setting_still_plans_modify_setting() -> None:
    plan = plan_diff(
        [_events(settings={"ttl_only_drop_parts": 0})], [_events(settings={"ttl_only_drop_parts": 1})]
    )
    assert [op.sql for op in plan.operations] == [
        "ALTER TABLE app.events MODIFY SETTING ttl_only_drop_parts = 1;"
    ]


def test_a_readonly_setting_change_recreates_the_table() -> None:
    plan = plan_diff([_events(settings={"index_granularity": "4096"})], [_events()])
    assert [(op.type, op.risk) for op in plan.operations] == [
        ("drop_table", "danger"),
        ("create_table", "safe"),
    ]
    assert "SETTINGS index_granularity = 8192;" in plan.operations[1].sql
    minmax = plan_diff(
        [_events()], [_events(settings={"add_minmax_index_for_numeric_columns": 1})]
    )
    assert [op.type for op in minmax.operations] == ["drop_table", "create_table"]


def test_hidden_minmax_indexes_the_server_creates_plan_nothing() -> None:
    auto_index = {"name": "auto_minmax_index_id", "expression": "id", "type": "minmax", "granularity": 1}
    with_auto = _events(settings={"add_minmax_index_for_numeric_columns": "1"}, indexes=[auto_index])
    without_auto = _events(settings={"add_minmax_index_for_numeric_columns": 1})
    assert plan_diff([with_auto], [without_auto]).operations == []
    assert plan_diff([without_auto], [with_auto]).operations == []
    # With the settings off, the server allows a user index of that name, so it is compared.
    user_index = _events(indexes=[auto_index])
    assert [op.type for op in plan_diff([_events()], [user_index]).operations] == [
        "alter_table_add_index"
    ]


def test_engines_outside_the_merge_tree_family_get_no_index_granularity() -> None:
    memory = table(
        database="app", name="buffer", engine="Memory()", columns=[{"name": "id", "type": "UInt64"}]
    )
    created = next(op for op in plan_diff([], [memory]).operations if op.type == "create_table")
    assert "index_granularity" not in created.sql


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


def test_pull_keeps_every_setting_the_server_stores() -> None:
    local = _introspected(
        "t", "MergeTree", {"index_granularity": "8192", "merge_with_ttl_timeout": "3600"}
    )
    pulled = _introspected_table_to_definition(local)
    assert pulled is not None
    assert pulled.settings == {"index_granularity": 8192, "merge_with_ttl_timeout": 3600}

    shared = _introspected(
        "t", "SharedMergeTree", {"storage_policy": "'s3'", "index_granularity": "4096"}
    )
    pulled = _introspected_table_to_definition(shared)
    assert pulled is not None
    assert pulled.settings == {"storage_policy": "'s3'", "index_granularity": 4096}


def test_pull_comments_the_settings_that_cannot_change() -> None:
    tables = [
        _introspected("local_t", "MergeTree", {"index_granularity": "8192", "merge_with_ttl_timeout": "3600"}),
        _introspected("shared_t", "SharedMergeTree", {"storage_policy": "'s3'"}),
        _introspected("self_hosted_s3", "MergeTree", {"storage_policy": "'s3'"}),
    ]
    definitions = [d for d in (_introspected_table_to_definition(t) for t in tables) if d is not None]
    assert [d.engine for d in definitions][1].startswith("Shared")
    content = render_schema_file(definitions, shared_tables=frozenset({"app.shared_t"}))
    assert (
        '"index_granularity": 8192,  # read-only: a change recreates the table '
        "(DROP + CREATE, or --cutover)"
    ) in content
    assert '"merge_with_ttl_timeout": 3600,\n' in content
    shared = content[content.index('name="shared_t"') :]
    assert (
        "\"storage_policy\": \"'s3'\",  # set by ObsessionDB on every Shared table; it cannot change"
    ) in shared[: shared.index("\n)\n")]
    # An 's3' policy a self-hosted server defines is an ordinary setting.
    self_hosted = content[content.index('name="self_hosted_s3"') :]
    assert "\"storage_policy\": \"'s3'\",\n" in self_hosted[: self_hosted.index("\n)\n")]


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
