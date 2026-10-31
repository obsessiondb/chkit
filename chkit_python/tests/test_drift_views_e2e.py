"""Drift compares view and materialized view queries and targets, live (#382).

ClickHouse stores a view's query reformatted and with its table names
qualified, so an unchanged view must read clean, and a view recreated with
another query or ``TO`` target must drift.
"""

from __future__ import annotations

from pathlib import Path

from chkit.cli.commands.drift_payload import build_drift_payload
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_view
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import ChxResolvedClickHouseConfig, materialized_view, table, view
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


def test_unchanged_views_read_clean_and_changed_query_or_target_drifts(tmp_path: Path) -> None:
    with _connect() as client:
        database = client.database
        prefix = create_prefix("drift_views")
        orders, by_day, by_day_alt = f"{prefix}orders", f"{prefix}by_day", f"{prefix}by_day_alt"
        report, orders_mv = f"{prefix}report", f"{prefix}orders_mv"
        mv_query = f"SELECT day, amount FROM {orders} WHERE status != 'Refunded'"
        target_columns = [{"name": "day", "type": "Date"}, {"name": "amount", "type": "UInt64"}]
        definitions = [
            table(
                database=database,
                name=orders,
                engine="MergeTree()",
                primary_key=["id"],
                order_by=["id"],
                columns=[
                    {"name": "id", "type": "UInt64"},
                    {"name": "day", "type": "Date"},
                    {"name": "amount", "type": "UInt64"},
                    {"name": "status", "type": "String"},
                ],
            ),
            *(
                table(
                    database=database,
                    name=name,
                    engine="MergeTree()",
                    primary_key=["day"],
                    order_by=["day"],
                    columns=target_columns,
                )
                for name in (by_day, by_day_alt)
            ),
            view(
                database=database,
                name=report,
                as_=(
                    f"WITH paid AS (SELECT id, day, amount FROM {orders} "
                    "WHERE status IN ('Paid','Shipped')) -- paid orders only\n"
                    "SELECT p.day AS day, sum(p.amount) AS revenue, "
                    "arrayMap(x -> x*2, [1,2]) AS doubled, /* note */ count() AS n\n"
                    "FROM paid AS p\n"
                    f"JOIN (SELECT day, count() AS c FROM {orders} GROUP BY day) AS d "
                    "ON p.day = d.day\n"
                    f"WHERE p.id IN (SELECT id FROM {database}.{orders} WHERE amount > 0)\n"
                    "GROUP BY p.day\n"
                    "SETTINGS max_threads = 2"
                ),
            ),
            materialized_view(
                database=database,
                name=orders_mv,
                to={"database": database, "name": by_day},
                as_=mv_query,
            ),
        ]
        snapshot = create_snapshot(canonicalize_definitions(definitions))

        def view_drift() -> list[tuple[str, str, str | None, str | None]]:
            payload = build_drift_payload(
                client=client, meta_dir=tmp_path, snapshot=snapshot, database=database
            )
            return [
                (d.code, d.object, d.expected, d.actual)
                for d in payload.object_drift
                if prefix in d.object
            ]

        try:
            for definition in definitions:
                client.execute(to_create_sql(definition))
            wait_for_view(client, database, report)
            wait_for_view(client, database, orders_mv)
            assert poll_until(view_drift, lambda seen: seen == []) == []

            # DROP + CREATE rather than CREATE OR REPLACE, which ObsessionDB does not
            # apply on every replica.
            client.execute(f"DROP VIEW {database}.{report} SYNC")
            client.execute(
                f"CREATE VIEW {database}.{report} AS SELECT day, sum(amount) AS revenue "
                f"FROM {database}.{orders} WHERE status != 'Refunded' GROUP BY day"
            )
            client.execute(f"DROP VIEW {database}.{orders_mv} SYNC")
            client.execute(
                f"CREATE MATERIALIZED VIEW {database}.{orders_mv} TO {database}.{by_day_alt} "
                f"AS {mv_query} AND amount > 0"
            )
            expected_codes = [
                ("query_mismatch", f"{database}.{orders_mv}"),
                ("target_mismatch", f"{database}.{orders_mv}"),
                ("query_mismatch", f"{database}.{report}"),
            ]
            drift = poll_until(
                view_drift, lambda seen: [(c, o) for c, o, _, _ in seen] == expected_codes
            )
            assert [(c, o) for c, o, _, _ in drift] == expected_codes
            assert drift[1][2:] == (f"{database}.{by_day}", f"{database}.{by_day_alt}")
        finally:
            client.execute(f"DROP VIEW IF EXISTS {database}.{orders_mv}")
            client.execute(f"DROP VIEW IF EXISTS {database}.{report}")
            for name in (orders, by_day, by_day_alt):
                client.execute(f"DROP TABLE IF EXISTS {database}.{name} SYNC")
