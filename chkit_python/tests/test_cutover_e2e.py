"""Zero-downtime cutover of a sort-key change (#202) under concurrent writers.

Port of the ``packages/cli/src/test/cutover*.e2e.test.ts`` files: against the local stack,
or ObsessionDB when ``CLICKHOUSE_URL`` / ``CLICKHOUSE_HOST`` point at it. The
2-shard cluster runs the same scenarios in
``tests_cluster/test_cutover_cluster_e2e.py``. An unreachable server fails the
test.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.cutover_scenario import (
    GRANULARITY_CHANGE,
    CutoverTarget,
    run_backfill_scenario,
    run_keep_scenario,
    run_refused_at_start_scenario,
    run_retry_scenario,
    run_stored_spelling_scenario,
    run_undeclared_primary_key_scenario,
)
from tests.e2e_testkit import resolve_live_env


@pytest.fixture
def target(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[CutoverTarget]:
    env = resolve_live_env()
    remote = env.clickhouse_url.startswith("https")
    config = ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=remote,
    )
    admin = ClickHouseClient.connect(config)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CI", "1")
    # create_cutover_project sets it; monkeypatch restores it afterwards.
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", "")
    database = env.clickhouse_database
    yield CutoverTarget(
        database=database,
        connection={
            "url": env.clickhouse_url,
            "username": env.clickhouse_user,
            "password": env.clickhouse_password,
            "database": database,
        },
        admin=admin,
        writer_configs=[config, config],
        engine="MergeTree",
        rows_of=lambda table: f"{database}.{table}",
        # A SharedMergeTree replica reads the parts every replica committed.
        read_settings=" SETTINGS select_sequential_consistency = 1" if remote else "",
    )
    admin.close()


def test_keeps_every_row_and_the_dependent_views_while_writers_insert(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_keep_scenario(target, "cutover_keep", tmp_path)


def test_copies_through_the_backfill_plugin_then_swaps_and_drops_the_old_table(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_backfill_scenario(target, "cutover_backfill", tmp_path)


def test_resumes_after_a_failure_at_every_step_whose_retry_differs_and_never_replays_the_swap(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_retry_scenario(target, "cutover_retry", tmp_path)


def test_cuts_over_an_index_granularity_change_and_its_layout_guards_tell_the_tables_apart(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_retry_scenario(target, "cutover_granularity", tmp_path, GRANULARITY_CHANGE, "layout guards")


def test_cuts_over_a_table_created_with_only_order_by(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_undeclared_primary_key_scenario(target, "cutover_pk", tmp_path)


# cityHash64 hashes both pairs alike, so the verify step after the copy would miss them.
MISTYPED = "stores a column with another type than the schema declares"


def test_stops_before_it_creates_anything_on_uint32_where_the_schema_says_uint64(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_refused_at_start_scenario(
        target,
        "cutover_uint",
        tmp_path,
        columns="id UInt32, user_id UInt64, payload String",
        engine=lambda _table: target.engine,
        message=MISTYPED,
    )


def test_stops_before_it_creates_anything_on_low_cardinality_where_the_schema_says_string(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_refused_at_start_scenario(
        target,
        "cutover_lowcard",
        tmp_path,
        columns="id UInt64, user_id UInt64, payload LowCardinality(String)",
        engine=lambda _table: target.engine,
        message=MISTYPED,
    )


BASE = [
    {"name": "id", "type": "UInt64"},
    {"name": "user_id", "type": "UInt64"},
    {"name": "payload", "type": "String"},
]


# ClickHouse stores Decimal64(2) as Decimal(18, 2): the same type, in another spelling.
def test_cuts_over_a_table_whose_types_clickhouse_stores_in_another_spelling(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_stored_spelling_scenario(
        target,
        "cutover_spelling",
        tmp_path,
        [
            *BASE,
            {"name": "price", "type": "Decimal64(2)"},
            {"name": "maybe_price", "type": "Decimal64(2)", "nullable": True},
            {"name": "prices", "type": "Array(Decimal64(2))"},
            {"name": "pair", "type": "Tuple(a Decimal128(4), `b c` INT)"},
        ],
    )


def test_stops_before_it_creates_anything_when_the_table_lacks_a_nested_column(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_refused_at_start_scenario(
        target,
        "cutover_nested_missing",
        tmp_path,
        columns="id UInt64, user_id UInt64, payload String",
        engine=lambda _table: target.engine,
        message="lacks a column that the schema declares",
        schema_columns=[*BASE, {"name": "n", "type": "Nested(x UInt64)"}],
    )


def test_stops_before_it_creates_anything_when_a_nested_field_has_another_type(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_refused_at_start_scenario(
        target,
        "cutover_nested_type",
        tmp_path,
        columns="id UInt64, user_id UInt64, payload String, n Nested(x UInt32)",
        engine=lambda _table: target.engine,
        message=MISTYPED,
        schema_columns=[*BASE, {"name": "n", "type": "Nested(x UInt64)"}],
    )


# The mirror, the copy and the verify skip an ALIAS column, so the stored values would be lost.
def test_stops_before_it_creates_anything_when_the_table_stores_a_column_the_schema_declares_alias(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_refused_at_start_scenario(
        target,
        "cutover_alias",
        tmp_path,
        columns="id UInt64, user_id UInt64, payload String, label String",
        engine=lambda _table: target.engine,
        message="stores a column that the schema declares ALIAS or EPHEMERAL",
        schema_columns=[
            *BASE,
            {"name": "label", "type": "String", "default_kind": "ALIAS", "default": "fn:payload"},
        ],
    )


# AS keeps the table's TTLs: a TTL merge on the snapshot could change rows before the copy.
@pytest.mark.parametrize(
    ("label", "columns", "clauses"),
    [
        (
            "cutover_table_ttl",
            "id UInt64, user_id UInt64, payload String",
            "TTL toDateTime(id) + toIntervalYear(100)",
        ),
        (
            "cutover_column_ttl",
            "id UInt64, user_id UInt64, payload String TTL toDateTime(id) + toIntervalYear(100)",
            "",
        ),
    ],
)
def test_stops_before_it_creates_anything_when_the_table_has_a_ttl(
    target: CutoverTarget, tmp_path: Path, label: str, columns: str, clauses: str
) -> None:
    run_refused_at_start_scenario(
        target,
        label,
        tmp_path,
        columns=columns,
        engine=lambda _table: target.engine,
        message="has a TTL",
        clauses=clauses,
    )
