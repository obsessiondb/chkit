"""1:1 port of ``packages/plugin-backfill/src/chunking/services/metadata-source.e2e.test.ts``.

Regression e2e for chkit#320: a part whose min/max index is empty reports
min_time = 1970-01-01 in system.parts. It must not pull its partition into
every --from/--to window.

Requires a reachable ClickHouse (defaults to the local test stack on
``CHKIT_TEST_PORT``, default 8123; see ``tests/e2e_testkit.py``). Hard-fails
when the server is unreachable — never skips.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_table
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.chunking.services.metadata_source import introspect_partitions
from chkit_plugin_backfill.chunking.types import Partition, PlannerContext, QuerySettings
from tests.e2e_testkit import create_prefix, poll_until, resolve_live_env


@pytest.fixture
def client() -> Iterator[ClickHouseClient]:
    env = resolve_live_env()
    config = ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=env.clickhouse_url.startswith("https"),
    )
    try:
        connected = ClickHouseClient.connect(config)
        connected.query("SELECT 1")
    except Exception as exc:  # connection failure must fail loudly, never skip
        pytest.fail(
            f"Failed to connect to ClickHouse at {env.clickhouse_url}: {exc!r}",
            pytrace=False,
        )
    yield connected
    connected.close()


def test_zero_min_time_part_does_not_widen_partition_into_window(
    client: ClickHouseClient,
) -> None:
    db = client.database
    table = f"{create_prefix('backfill_epoch_parts')}events"
    fqn = f"{db}.{table}"

    def query(sql: str, settings: QuerySettings | None) -> list[dict[str, object]]:
        return client.query(sql, dict(settings) if settings is not None else None).rows

    def partitions_in(from_: str, to: str) -> list[tuple[str, str]]:
        context = PlannerContext(
            database=db,
            table=table,
            target_chunk_bytes=1024**3,
            query=query,
            row_probe_strategy="count",
            from_=from_,
            to=to,
        )
        return [(p.partition_id, p.min_time) for p in introspect_partitions(context)]

    try:
        # remove_empty_parts = 0 keeps the empty part a DELETE mutation leaves
        # behind, which background cleanup would otherwise drop at an
        # unpredictable time.
        client.execute(
            f"""
            CREATE TABLE {fqn} (id UInt64, t DateTime)
            ENGINE = MergeTree
            PARTITION BY toYYYYMM(t)
            ORDER BY (t, id)
            SETTINGS remove_empty_parts = 0
            """
        )
        wait_for_table(client, db, table)
        for start in ("2020-10-05", "2026-10-01", "2026-10-20"):
            client.execute(
                f"INSERT INTO {fqn} SELECT number, "
                f"toDateTime('{start} 00:00:00') + number * 60 FROM numbers(100)"
            )
        client.execute(
            f"ALTER TABLE {fqn} DELETE WHERE t >= '2026-10-20 00:00:00' "
            "SETTINGS mutations_sync = 2"
        )

        zero_parts = poll_until(
            lambda: client.query(
                "SELECT partition_id FROM system.parts "
                f"WHERE database = '{db}' AND table = '{table}' AND active = 1 "
                "AND min_time = 0 SETTINGS select_sequential_consistency = 1"
            ).rows,
            lambda rows: len(rows) > 0,
        )
        assert [row["partition_id"] for row in zero_parts] == ["202610"]

        october_2020 = partitions_in("2020-10-01T00:00:00.000Z", "2020-11-01T00:00:00.000Z")
        assert [partition_id for partition_id, _ in october_2020] == ["202010"]

        october_2026 = partitions_in("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z")
        assert october_2026 == [("202610", "2026-10-01T00:00:00.000Z")]
    finally:
        client.execute(f"DROP TABLE IF EXISTS {fqn}")


def test_date_partition_column_windows_by_min_date_max_date(
    client: ClickHouseClient,
) -> None:
    # chkit#352: for a Date partition column system.parts reports min_time =
    # max_time = 1970-01-01 and fills min_date/max_date instead.
    db = client.database
    table = f"{create_prefix('backfill_date_parts')}events"
    fqn = f"{db}.{table}"

    def query(sql: str, settings: QuerySettings | None) -> list[dict[str, object]]:
        return client.query(sql, dict(settings) if settings is not None else None).rows

    def partitions_in(from_: str, to: str) -> list[Partition]:
        context = PlannerContext(
            database=db,
            table=table,
            target_chunk_bytes=1024**3,
            query=query,
            row_probe_strategy="count",
            from_=from_,
            to=to,
        )
        return introspect_partitions(context)

    try:
        client.execute(
            f"""
            CREATE TABLE {fqn} (id UInt64, d Date)
            ENGINE = MergeTree
            PARTITION BY toYYYYMM(d)
            ORDER BY (d, id)
            SETTINGS remove_empty_parts = 0
            """
        )
        wait_for_table(client, db, table)
        client.execute(
            f"INSERT INTO {fqn} SELECT number, toDate('2026-08-01') + number FROM numbers(70)"
        )
        client.execute(f"INSERT INTO {fqn} SELECT number, toDate('2026-09-20') FROM numbers(10)")
        client.execute(
            f"ALTER TABLE {fqn} DELETE WHERE d = '2026-09-20' SETTINGS mutations_sync = 2"
        )

        parts = poll_until(
            lambda: client.query(
                "SELECT partition_id, toString(min(min_time)) AS min_time, "
                "toString(min(min_date)) AS min_date FROM system.parts "
                f"WHERE database = '{db}' AND table = '{table}' AND active = 1 "
                "GROUP BY partition_id ORDER BY partition_id "
                "SETTINGS select_sequential_consistency = 1"
            ).rows,
            lambda rows: len(rows) == 3 and rows[1]["min_date"] == "1970-01-01",
        )
        assert parts == [
            {"partition_id": "202608", "min_time": "1970-01-01 00:00:00", "min_date": "2026-08-01"},
            {"partition_id": "202609", "min_time": "1970-01-01 00:00:00", "min_date": "1970-01-01"},
            {"partition_id": "202610", "min_time": "1970-01-01 00:00:00", "min_date": "2026-10-01"},
        ]

        september = partitions_in("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z")
        assert [(p.partition_id, p.min_time, p.max_time) for p in september] == [
            ("202609", "2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.000Z")
        ]

        last_day_of_august = partitions_in("2026-08-31T12:00:00.000Z", "2026-09-01T00:00:00.000Z")
        assert [p.partition_id for p in last_day_of_august] == ["202608"]
    finally:
        client.execute(f"DROP TABLE IF EXISTS {fqn}")
