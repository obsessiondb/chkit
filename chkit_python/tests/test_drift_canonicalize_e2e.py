"""Drift compares SQL expressions in ClickHouse's canonical form (#195), live.

ClickHouse stores `cityHash64(a,b)` as `cityHash64(a, b)` and
`INTERVAL 5 YEAR` as `toIntervalYear(5)`; a schema written the other way must
not report drift once the table exists.
"""

from __future__ import annotations

from pathlib import Path

from chkit.cli.commands.drift_compare import compare_table_shape
from chkit.cli.commands.drift_payload import build_drift_payload
from chkit.clickhouse.canonicalize import canonicalize_sql_fragments
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_table
from chkit.clickhouse.introspect import list_table_details
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import (
    ChxResolvedClickHouseConfig,
    SkipIndexMinmax,
    TableDefinition,
    table,
)
from chkit.core.snapshot import create_snapshot
from chkit.core.sql import to_create_sql
from tests.e2e_testkit import create_prefix, poll_until, resolve_live_env


def _connect() -> ClickHouseClient:
    env = resolve_live_env()
    return ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    )


def test_canonicalize_sql_fragments_uses_clickhouse_formatting() -> None:
    with _connect() as client:
        expressions = canonicalize_sql_fragments(
            client, ["cityHash64(a,b)", "ts + INTERVAL 5 YEAR", "((bad"], wrap=True
        )
        queries = canonicalize_sql_fragments(client, ["SELECT a,count() GROUP BY a"], wrap=False)

    assert expressions["cityHash64(a,b)"] == "cityHash64(a, b)"
    assert expressions["ts + INTERVAL 5 YEAR"] == "ts + toIntervalYear(5)"
    assert "((bad" not in expressions
    assert queries["SELECT a,count() GROUP BY a"] == "SELECT a, count() GROUP BY a"


def test_expressions_spelled_differently_from_clickhouse_report_no_drift(tmp_path: Path) -> None:
    with _connect() as client:
        database = client.database
        name = create_prefix("drift_canonical") + "events"
        definition = table(
            database=database,
            name=name,
            engine="MergeTree()",
            columns=[
                {"name": "a", "type": "String"},
                {"name": "b", "type": "String"},
                {"name": "ts", "type": "DateTime"},
            ],
            primary_key=["a"],
            order_by=["a", "cityHash64(a,b)"],
            partition_by="toYYYYMM(ts)",
            ttl="ts + INTERVAL 5 YEAR",
            indexes=[SkipIndexMinmax(name="i", expression="cityHash64(a,b)", granularity=1)],
        )
        snapshot = create_snapshot(canonicalize_definitions([definition]))
        try:
            client.execute(to_create_sql(definition))
            wait_for_table(client, database, name)

            def observe() -> tuple[list[str], list[str]]:
                payload = build_drift_payload(
                    client=client, meta_dir=tmp_path, snapshot=snapshot, database=database
                )
                return (
                    [key for key in payload.missing if name in key],
                    [detail.table for detail in payload.table_drift if name in detail.table],
                )

            # Each read may land on a replica that has not applied the CREATE yet.
            missing, drifted = poll_until(observe, lambda seen: seen == ([], []))
            assert (missing, drifted) == ([], [])

            # Plain string comparison alone still sees the spelling difference.
            actual = poll_until(
                lambda: next(
                    (t for t in list_table_details(client, [database]) if t.name == name), None
                ),
                lambda found: found is not None,
            )
            assert actual is not None
            expected = snapshot.definitions[0]
            assert isinstance(expected, TableDefinition)
            detail = compare_table_shape(expected, actual)
            assert detail is not None
            assert "index_mismatch" in detail.reason_codes
        finally:
            client.execute(f"DROP TABLE IF EXISTS {database}.{name} SYNC")
