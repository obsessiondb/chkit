"""Port of ``packages/clickhouse/src/ddl-propagation.e2e.test.ts`` (#231).

``migrate`` calls ``wait_for_ddl_propagation`` after every statement. On
managed ClickHouse (e.g. ObsessionDB) DDL propagates asynchronously, so
creating a view that reads another view only succeeds reliably once the first
CREATE is visible. The client is live; the wrapper only records the polling
queries.
"""

from __future__ import annotations

from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

from chkit.clickhouse.ddl_propagation import wait_for_ddl_propagation, wait_for_table
from chkit.clickhouse.replicas import ReplicaFanout, all_replicas, resolve_replica_fanout
from tests.e2e_testkit import create_prefix, quote_ident, run_once_visible


class _LiveClient:
    """Adapts clickhouse-connect to the ``query(sql) -> .rows`` shape the waits use."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self.queries: list[str] = []

    def query(self, sql: str) -> SimpleNamespace:
        self.queries.append(sql)
        return SimpleNamespace(rows=list(self._client.query(sql).named_results()))


# The target's replicas, probed by ``_recorder``: one replica reads the system
# table directly, several count the replicas that show the change (#265).
_fanout: ReplicaFanout | None = None


def _recorder(live: _LiveClient) -> Callable[[str, str], list[str]]:
    """Run ``wait_for_ddl_propagation`` and return the distinct polling queries it sent."""
    global _fanout  # noqa: PLW0603
    _fanout = resolve_replica_fanout(live)

    def run(operation_type: str, operation_key: str) -> list[str]:
        live.queries.clear()
        wait_for_ddl_propagation(live, operation_type, operation_key)
        return list(dict.fromkeys(live.queries))

    return run


def _polled(source: str, where: str) -> str:
    if _fanout is None:
        return f"SELECT 1 AS x FROM {source} WHERE {where}"
    return (
        "SELECT count(DISTINCT hostName()) AS replicas "
        f"FROM {all_replicas(_fanout, source)} WHERE {where}"
    )


# The polling queries for names that need no escaping in a string literal.
def _listed(db: str, name: str) -> str:
    return _polled("system.tables", f"database = '{db}' AND name = '{name}'")


def _listed_as_view(db: str, name: str) -> str:
    return _polled(
        "system.tables", f"database = '{db}' AND name = '{name}' AND engine LIKE '%View%'"
    )


def _column_listed(db: str, table: str, column: str) -> str:
    return _polled(
        "system.columns", f"database = '{db}' AND table = '{table}' AND name = '{column}'"
    )


def _index_listed(db: str, table: str, index: str) -> str:
    return _polled(
        "system.data_skipping_indices",
        f"database = '{db}' AND table = '{table}' AND name = '{index}'",
    )


def test_waits_for_created_views_and_materialized_views_and_dropped_ones(ch_client: Any) -> None:
    client = ch_client._client
    live = _LiveClient(client)
    polling = _recorder(live)
    db = client.database
    p = create_prefix("ddlwait")
    source, target, view, mv = f"{p}src", f"{p}dst", f"{p}v", f"{p}mv"

    def obj(name: str) -> str:
        return f"{quote_ident(db)}.{quote_ident(name)}"

    def run(sql: str) -> None:
        run_once_visible(lambda: client.command(sql))

    try:
        client.command(f"CREATE TABLE {obj(source)} (id UInt64) ENGINE = MergeTree ORDER BY id")
        client.command(f"CREATE TABLE {obj(target)} (id UInt64) ENGINE = MergeTree ORDER BY id")
        wait_for_table(live, db, source)
        wait_for_table(live, db, target)

        run(f"CREATE VIEW {obj(view)} AS SELECT id FROM {obj(source)}")
        assert polling("create_view", f"view:{db}.{view}") == [_listed_as_view(db, view)]

        run(
            f"CREATE MATERIALIZED VIEW {obj(mv)} TO {obj(target)} AS SELECT id FROM {obj(source)}"
        )
        assert polling("create_materialized_view", f"materialized_view:{db}.{mv}") == [
            _listed_as_view(db, mv)
        ]
        # MODIFY REFRESH keys carry a suffix; the wait checks the view still exists.
        assert polling(
            "alter_materialized_view_modify_refresh", f"materialized_view:{db}.{mv}:refresh"
        ) == [_listed(db, mv)]

        run(f"DROP VIEW {obj(view)}")
        assert polling("drop_view", f"view:{db}.{view}") == [_listed(db, view)]
        run(f"DROP VIEW {obj(mv)}")
        assert polling("drop_materialized_view", f"materialized_view:{db}.{mv}") == [
            _listed(db, mv)
        ]
    finally:
        client.command(f"DROP VIEW IF EXISTS {obj(view)}")
        client.command(f"DROP VIEW IF EXISTS {obj(mv)}")
        client.command(f"DROP TABLE IF EXISTS {obj(source)}")
        client.command(f"DROP TABLE IF EXISTS {obj(target)}")


def test_waits_for_objects_and_columns_whose_names_contain_quotes_and_backslashes(
    ch_client: Any,
) -> None:
    client = ch_client._client
    live = _LiveClient(client)
    db = client.database
    p = create_prefix("ddlwait_quoted")
    table = f"{p}o'brien\\t"
    view = f"{p}o'brien\\v"
    column = "it's\\c"

    def obj(name: str) -> str:
        return f"{quote_ident(db)}.{quote_ident(name)}"

    def run(sql: str) -> None:
        run_once_visible(lambda: client.command(sql))

    try:
        client.command(f"CREATE TABLE {obj(table)} (id UInt64) ENGINE = MergeTree ORDER BY id")
        wait_for_ddl_propagation(live, "create_table", f"table:{db}.{table}")
        run(f"ALTER TABLE {obj(table)} ADD COLUMN {quote_ident(column)} String")
        wait_for_ddl_propagation(live, "alter_table_add_column", f"table:{db}.{table}:column:{column}")
        run(f"CREATE VIEW {obj(view)} AS SELECT id FROM {obj(table)}")
        wait_for_ddl_propagation(live, "create_view", f"view:{db}.{view}")
        run(f"DROP VIEW {obj(view)}")
        wait_for_ddl_propagation(live, "drop_view", f"view:{db}.{view}")
    finally:
        client.command(f"DROP VIEW IF EXISTS {obj(view)}")
        client.command(f"DROP TABLE IF EXISTS {obj(table)}")


def test_waits_for_the_whole_name_of_objects_and_columns_containing_colons(ch_client: Any) -> None:
    client = ch_client._client
    live = _LiveClient(client)
    polling = _recorder(live)
    db = client.database
    p = create_prefix("ddlwait_colon")
    table = f"{p}t:1"
    target = f"{p}dst"
    column = "c:1"
    index = "i:1"
    view = f"{p}v:1"
    # Ends like a MODIFY REFRESH key, so only the key's last `:refresh` is cut.
    mv = f"{p}mv:refresh"

    def obj(name: str) -> str:
        return f"{quote_ident(db)}.{quote_ident(name)}"

    def run(sql: str) -> None:
        run_once_visible(lambda: client.command(sql))

    try:
        client.command(f"CREATE TABLE {obj(table)} (id UInt64) ENGINE = MergeTree ORDER BY id")
        assert polling("create_table", f"table:{db}.{table}") == [_listed(db, table)]
        run(f"ALTER TABLE {obj(table)} ADD COLUMN {quote_ident(column)} String")
        assert polling("alter_table_add_column", f"table:{db}.{table}:column:{column}") == [
            _column_listed(db, table, column)
        ]
        # Python also waits for the index itself (TS checks only the table), so
        # the index is created first; its name is cut at the key's `:index:`.
        run(
            f"ALTER TABLE {obj(table)} ADD INDEX {quote_ident(index)} id TYPE minmax GRANULARITY 1"
        )
        assert polling("alter_table_add_index", f"table:{db}.{table}:index:{index}") == [
            _index_listed(db, table, index)
        ]

        client.command(f"CREATE TABLE {obj(target)} (id UInt64) ENGINE = MergeTree ORDER BY id")
        wait_for_table(live, db, target)
        run(f"CREATE VIEW {obj(view)} AS SELECT id FROM {obj(table)}")
        assert polling("create_view", f"view:{db}.{view}") == [_listed_as_view(db, view)]
        run(
            f"CREATE MATERIALIZED VIEW {obj(mv)} TO {obj(target)} AS SELECT id FROM {obj(table)}"
        )
        assert polling("create_materialized_view", f"materialized_view:{db}.{mv}") == [
            _listed_as_view(db, mv)
        ]
        assert polling(
            "alter_materialized_view_modify_refresh", f"materialized_view:{db}.{mv}:refresh"
        ) == [_listed(db, mv)]

        # A drop wait that polled a shortened name would pass without waiting.
        run(f"DROP VIEW {obj(view)}")
        assert polling("drop_view", f"view:{db}.{view}") == [_listed(db, view)]
        run(f"DROP VIEW {obj(mv)}")
        assert polling("drop_materialized_view", f"materialized_view:{db}.{mv}") == [
            _listed(db, mv)
        ]
        run(f"DROP TABLE {obj(table)}")
        assert polling("drop_table", f"table:{db}.{table}") == [_listed(db, table)]
    finally:
        client.command(f"DROP VIEW IF EXISTS {obj(view)}")
        client.command(f"DROP VIEW IF EXISTS {obj(mv)}")
        client.command(f"DROP TABLE IF EXISTS {obj(table)}")
        client.command(f"DROP TABLE IF EXISTS {obj(target)}")
