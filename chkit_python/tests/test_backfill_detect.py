"""Port of ``packages/plugin-backfill/src/detect.test.ts``."""

from __future__ import annotations

from chkit.core.model import SchemaDefinition, materialized_view, table
from chkit_plugin_backfill.detect import (
    detect_candidates_from_table,
    extract_schema_time_column,
    find_mvs_for_target,
    find_table_for_target,
    resolve_mv_replay_source,
)


def test_finds_datetime_column_in_order_by_as_top_candidate() -> None:
    definition = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "session_date", "type": "DateTime64"},
            {"name": "data", "type": "String"},
        ],
        engine="MergeTree",
        primary_key=["session_date"],
        order_by=["session_date", "id"],
    )

    candidates = detect_candidates_from_table(definition)

    assert len(candidates) == 1
    assert candidates[0].name == "session_date"
    assert candidates[0].source == "order_by"


def test_finds_common_time_column_names_via_column_scan() -> None:
    definition = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "created_at", "type": "DateTime"},
            {"name": "data", "type": "String"},
        ],
        engine="MergeTree",
        primary_key=["id"],
        order_by=["id"],
    )

    candidates = detect_candidates_from_table(definition)

    assert len(candidates) == 1
    assert candidates[0].name == "created_at"
    assert candidates[0].source == "column_scan"


def test_ranks_order_by_candidates_before_column_scan_candidates() -> None:
    definition = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "ingested_at", "type": "DateTime64"},
            {"name": "event_time", "type": "DateTime"},
        ],
        engine="MergeTree",
        primary_key=["event_time"],
        order_by=["event_time", "id"],
    )

    candidates = detect_candidates_from_table(definition)

    assert len(candidates) == 2
    assert candidates[0].name == "event_time"
    assert candidates[0].source == "order_by"
    assert candidates[1].name == "ingested_at"
    assert candidates[1].source == "column_scan"


def test_returns_empty_candidates_when_no_datetime_columns_exist() -> None:
    definition = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "data", "type": "String"},
        ],
        engine="MergeTree",
        primary_key=["id"],
        order_by=["id"],
    )

    candidates = detect_candidates_from_table(definition)

    assert len(candidates) == 0


def test_handles_datetime64_with_parameters() -> None:
    definition = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "created_at", "type": "DateTime64(3, 'UTC')"},
        ],
        engine="MergeTree",
        primary_key=["id"],
        order_by=["id"],
    )

    candidates = detect_candidates_from_table(definition)

    assert len(candidates) == 1
    assert candidates[0].name == "created_at"


def test_does_not_duplicate_column_appearing_in_both_order_by_and_common_names() -> None:
    definition = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "event_time", "type": "DateTime"},
        ],
        engine="MergeTree",
        primary_key=["event_time"],
        order_by=["event_time", "id"],
    )

    candidates = detect_candidates_from_table(definition)

    assert len(candidates) == 1
    assert candidates[0].name == "event_time"
    assert candidates[0].source == "order_by"


def test_find_table_for_target_resolves_direct_table_match() -> None:
    definitions: list[SchemaDefinition] = [
        table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree",
            primary_key=["id"],
            order_by=["id"],
        ),
    ]

    found = find_table_for_target(definitions, "app", "events")

    assert found is not None
    assert found.name == "events"


def test_find_table_for_target_resolves_mv_target_to_source_table() -> None:
    source_table = table(
        database="app",
        name="raw_events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "created_at", "type": "DateTime"},
        ],
        engine="MergeTree",
        primary_key=["id"],
        order_by=["id"],
    )

    mv = materialized_view(
        database="app",
        name="events_mv",
        to={"database": "app", "name": "events_agg"},
        as_="SELECT * FROM app.raw_events",
    )

    definitions: list[SchemaDefinition] = [source_table, mv]
    found = find_table_for_target(definitions, "app", "events_agg")

    assert found is not None
    assert found.name == "raw_events"


def test_find_table_for_target_returns_none_when_no_match() -> None:
    definitions: list[SchemaDefinition] = [
        table(
            database="app",
            name="users",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree",
            primary_key=["id"],
            order_by=["id"],
        ),
    ]

    found = find_table_for_target(definitions, "app", "events")

    assert found is None


def test_extract_schema_time_column_reads_plugins_backfill_time_column() -> None:
    definition = table(
        database="app",
        name="events",
        columns=[
            {"name": "id", "type": "UInt64"},
            {"name": "event_time", "type": "DateTime"},
        ],
        engine="MergeTree",
        primary_key=["event_time"],
        order_by=["event_time", "id"],
        plugins={"backfill": {"timeColumn": "event_time"}},
    )

    assert extract_schema_time_column(definition) == "event_time"


def test_extract_schema_time_column_returns_none_when_no_plugins_config() -> None:
    definition = table(
        database="app",
        name="events",
        columns=[{"name": "id", "type": "UInt64"}],
        engine="MergeTree",
        primary_key=["id"],
        order_by=["id"],
    )

    assert extract_schema_time_column(definition) is None


def test_extract_schema_time_column_returns_none_when_backfill_config_has_no_time_column() -> None:
    definition = table(
        database="app",
        name="events",
        columns=[{"name": "id", "type": "UInt64"}],
        engine="MergeTree",
        primary_key=["id"],
        order_by=["id"],
        plugins={"backfill": {}},
    )

    assert extract_schema_time_column(definition) is None


def test_find_mvs_for_target_returns_mv_matching_target_to_database_and_to_name() -> None:
    mv = materialized_view(
        database="app",
        name="events_mv",
        to={"database": "app", "name": "events_agg"},
        as_="SELECT count() FROM app.events",
    )
    definitions: list[SchemaDefinition] = [
        table(
            database="app",
            name="events_agg",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree",
            primary_key=["id"],
            order_by=["id"],
        ),
        mv,
    ]

    found = find_mvs_for_target(definitions, "app", "events_agg")

    assert len(found) == 1
    assert found[0].name == "events_mv"
    assert found[0].as_ == "SELECT count() FROM app.events"


def test_find_mvs_for_target_returns_an_empty_list_when_no_mv_targets_the_table() -> None:
    definitions: list[SchemaDefinition] = [
        table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree",
            primary_key=["id"],
            order_by=["id"],
        ),
    ]

    assert find_mvs_for_target(definitions, "app", "events") == []


def test_find_mvs_for_target_returns_all_mvs_when_multiple_target_the_same_table() -> None:
    mv1 = materialized_view(
        database="app",
        name="hourly_mv",
        to={"database": "app", "name": "events_agg"},
        as_="SELECT toStartOfHour(ts) AS ts, count() AS c FROM app.events GROUP BY ts",
    )
    mv2 = materialized_view(
        database="app",
        name="daily_mv",
        to={"database": "app", "name": "events_agg"},
        as_="SELECT toStartOfDay(ts) AS ts, count() AS c FROM app.events GROUP BY ts",
    )
    definitions: list[SchemaDefinition] = [mv1, mv2]

    found = find_mvs_for_target(definitions, "app", "events_agg")

    assert [mv.name for mv in found] == ["hourly_mv", "daily_mv"]


def test_resolve_mv_replay_source_resolves_the_qualified_from_table_of_a_single_mv() -> None:
    mv = materialized_view(
        database="app",
        name="events_mv",
        to={"database": "app", "name": "events_agg"},
        as_="SELECT toStartOfHour(ts) AS ts, count() AS c FROM solana.raw_events GROUP BY ts",
    )

    assert resolve_mv_replay_source([mv]) == {"database": "solana", "table": "raw_events"}


def test_resolve_mv_replay_source_collapses_multiple_mvs_sharing_one_source() -> None:
    hourly = materialized_view(
        database="app",
        name="hourly_mv",
        to={"database": "app", "name": "events_agg"},
        as_="SELECT toStartOfHour(ts) AS ts, count() AS c FROM app.raw_events GROUP BY ts",
    )
    daily = materialized_view(
        database="app",
        name="daily_mv",
        to={"database": "app", "name": "events_agg"},
        as_="SELECT toStartOfDay(ts) AS ts, count() AS c FROM app.raw_events GROUP BY ts",
    )

    assert resolve_mv_replay_source([hourly, daily]) == {"database": "app", "table": "raw_events"}


def test_resolve_mv_replay_source_defaults_an_unqualified_from_to_the_mv_database() -> None:
    mv = materialized_view(
        database="analytics",
        name="events_mv",
        to={"database": "analytics", "name": "events_agg"},
        as_="SELECT count() AS c FROM raw_events",
    )

    assert resolve_mv_replay_source([mv]) == {"database": "analytics", "table": "raw_events"}


def test_resolve_mv_replay_source_returns_none_when_mvs_fan_in_from_different_sources() -> None:
    web = materialized_view(
        database="app",
        name="web_mv",
        to={"database": "app", "name": "events_agg"},
        as_="SELECT count() AS c FROM app.web_events",
    )
    api = materialized_view(
        database="app",
        name="api_mv",
        to={"database": "app", "name": "events_agg"},
        as_="SELECT count() AS c FROM app.api_events",
    )

    assert resolve_mv_replay_source([web, api]) is None


def test_resolve_mv_replay_source_returns_none_when_the_from_is_a_subquery() -> None:
    mv = materialized_view(
        database="app",
        name="events_mv",
        to={"database": "app", "name": "events_agg"},
        as_="SELECT count() AS c FROM (SELECT * FROM app.raw_events) GROUP BY 1",
    )

    assert resolve_mv_replay_source([mv]) is None
