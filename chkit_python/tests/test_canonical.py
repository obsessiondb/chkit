"""Canonicalization tests."""

from __future__ import annotations

from chkit.core.canonical import canonicalize_definitions, definition_key
from chkit.core.model import ColumnDefinition, table


def _events() -> list[ColumnDefinition]:
    return [
        ColumnDefinition(name="ts", type="DateTime"),
        ColumnDefinition(name="user_id", type="UInt64"),
    ]


def test_canonical_trims_and_sorts() -> None:
    raw = table(
        database=" default ",
        name=" events ",
        engine="MergeTree",
        columns=_events(),
        primary_key=["ts"],
        order_by=["ts, user_id"],
    )
    canon = canonicalize_definitions([raw])
    assert len(canon) == 1
    only = canon[0]
    assert only.database == "default"
    assert only.name == "events"
    # `order_by` is only present on TableDefinition; the dispatch via the
    # discriminated union upgrades the type after the kind check.
    assert only.kind == "table"
    assert only.order_by == ["ts", "user_id"]  # type: ignore[union-attr]


def test_definition_key_is_kind_db_name() -> None:
    raw = table(
        database="default",
        name="events",
        engine="MergeTree",
        columns=_events(),
        primary_key=["ts"],
        order_by=["ts"],
    )
    assert definition_key(raw) == "table:default.events"


def test_canonical_deduplicates_repeated_definitions() -> None:
    raw = table(
        database="default",
        name="events",
        engine="MergeTree",
        columns=_events(),
        primary_key=["ts"],
        order_by=["ts"],
    )
    canon = canonicalize_definitions([raw, raw])
    assert len(canon) == 1
