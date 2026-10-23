"""Port of ``packages/clickhouse/src/ddl-definition-wait.e2e.test.ts`` (#290).

``migrate`` waits after each statement until every replica shows what the
statement set. These run the planner's statements against the live target, so a
column definition ClickHouse formats differently from how chkit wrote it would
time out here.
"""

from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Any

import pytest

from chkit import table
from chkit.clickhouse.ddl_propagation import wait_for_ddl_propagation
from chkit.clickhouse.replicas import all_replicas, resolve_replica_fanout
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from tests.e2e_testkit import create_prefix, quote_ident

_ON_OBSESSIONDB = os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb"


class _LiveClient:
    """Adapts clickhouse-connect to the ``query(sql) -> .rows`` shape the waits use."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def query(self, sql: str) -> SimpleNamespace:
        return SimpleNamespace(rows=list(self._client.query(sql).named_results()))


def test_planned_modify_remove_rename_and_index_statements_pass_the_wait(ch_client: Any) -> None:
    client = ch_client._client
    live = _LiveClient(client)
    db = client.database
    name = f"{create_prefix('defwait_py')}t"
    columns: list[dict[str, Any]] = [
        {"name": "id", "type": "UInt32"},
        {"name": "raw", "type": "String", "default_kind": "EPHEMERAL"},
        {"name": "s", "type": "String", "default": "abc", "comment": "c1", "codec": {"kind": "ZSTD", "level": 3}},
        {"name": "a", "type": "UInt64", "default": "fn:length(raw)"},
        {"name": "b", "type": "UInt64", "default_kind": "MATERIALIZED", "default": "fn:a+1"},
        {"name": "c", "type": "String", "default_kind": "ALIAS", "default": "fn:concat(s,'-',toString(id))"},
        {"name": "d", "type": "Decimal(10,2)", "default": 1.5},
        {"name": "e", "type": "Array(UInt8)", "default": "fn:[1,2,3]"},
        {"name": "f", "type": "UInt8", "default": "fn:if(id>10,1,0)"},
        {"name": "v", "type": "Date", "default": "fn:toDate(now()) - INTERVAL 1 DAY"},
        {"name": "m", "type": "DateTime64(3, 'UTC')", "default": "fn:now64(3)"},
        {"name": "x", "type": "UInt64", "codec": [{"kind": "Delta"}, {"kind": "ZSTD"}]},
        {"name": "k", "type": "UInt32", "default_kind": "MATERIALIZED", "default": "fn:id"},
        {"name": "old:name", "type": "String"},
    ]
    changes: dict[str, dict[str, Any]] = {
        "s": {"default": "fn:lower(toString(id)) || 'x'", "comment": "it's"},
        "a": {"default": "fn:length(raw)*2+1"},
        "b": {"default": "fn:a+2"},
        "c": {"default": "fn:s||'-'||toString(id)"},
        "d": {"type": "Decimal(12,3)", "default": 2.5},
        "e": {"default": "fn:[4,5]"},
        "f": {"default": "fn:id > 10 AND id != 20"},
        "v": {"default": "fn:toDate(now()) - INTERVAL 2 DAY"},
        "k": {"default_kind": "DEFAULT", "default": "fn:id*2"},
    }
    replaced = {"m": {"name": "m", "type": "DateTime64(3, 'UTC')"}, "x": {"name": "x", "type": "UInt64"}}

    def definition(cols: list[dict[str, Any]], index: str, granularity: int) -> Any:
        return table(
            database=db,
            name=name,
            engine="MergeTree()",
            primary_key=["id"],
            order_by=["id"],
            columns=cols,
            indexes=[{"name": "idx", "expression": index, "type": "minmax", "granularity": granularity}],
        )

    before = definition(columns, "a", 1)
    after = definition(
        [replaced.get(col["name"], {**col, **changes.get(col["name"], {})}) for col in columns], "b", 2
    )
    qualified = f"{quote_ident(db)}.{quote_ident(name)}"
    try:
        client.command(to_create_sql(before))
        wait_for_ddl_propagation(live, "create_table", f"table:{db}.{name}")
        operations = plan_diff([before], [after]).operations
        assert sorted(op.type for op in operations) == [
            "alter_table_add_index",
            "alter_table_drop_index",
            *["alter_table_modify_column"] * 12,
        ]
        for operation in operations:
            client.command(operation.sql)
            wait_for_ddl_propagation(live, operation.type, operation.key, statement=operation.sql)
        rename = (
            f"ALTER TABLE {qualified} RENAME COLUMN IF EXISTS "
            f"{quote_ident('old:name')} TO {quote_ident('new')};"
        )
        client.command(rename)
        wait_for_ddl_propagation(
            live,
            "alter_table_rename_column",
            f"table:{db}.{name}:column_rename:old:name:new",
            statement=rename,
        )

        for replica in _every_replica(
            live,
            "name, default_kind, default_expression, comment, compression_codec",
            f"database = '{db}' AND table = '{name}' "
            "AND name IN ('s', 'm', 'x', 'k', 'old:name', 'new')",
        ):
            assert replica == [
                {"name": "k", "default_kind": "DEFAULT", "default_expression": "id * 2", "comment": "", "compression_codec": ""},
                {"name": "m", "default_kind": "", "default_expression": "", "comment": "", "compression_codec": ""},
                {"name": "new", "default_kind": "", "default_expression": "", "comment": "", "compression_codec": ""},
                {
                    "name": "s",
                    "default_kind": "DEFAULT",
                    "default_expression": "concat(lower(toString(id)), 'x')",
                    "comment": "it's",
                    "compression_codec": "CODEC(ZSTD(3))",
                },
                {"name": "x", "default_kind": "", "default_expression": "", "comment": "", "compression_codec": ""},
            ]
    finally:
        client.command(f"DROP TABLE IF EXISTS {qualified} SYNC")


def test_a_definition_the_server_does_not_show_fails_the_wait_naming_the_field(
    ch_client: Any,
) -> None:
    client = ch_client._client
    live = _LiveClient(client)
    db = client.database
    name = f"{create_prefix('defwait_py_miss')}t"
    qualified = f"{quote_ident(db)}.{quote_ident(name)}"
    try:
        client.command(
            f"CREATE TABLE {qualified} (id UInt32, s String DEFAULT 'old') ENGINE = MergeTree ORDER BY id"
        )
        wait_for_ddl_propagation(live, "create_table", f"table:{db}.{name}")
        # The statement never runs, as if the server accepted it without
        # applying it. A wait that only checks the column is listed would pass.
        with pytest.raises(
            RuntimeError, match="reports default_expression \"'old'\", the statement sets \"'new'\""
        ):
            wait_for_ddl_propagation(
                live,
                "alter_table_modify_column",
                f"table:{db}.{name}:column:s",
                statement=f"ALTER TABLE {qualified} MODIFY COLUMN `s` String DEFAULT 'new';",
            )
    finally:
        client.command(f"DROP TABLE IF EXISTS {qualified} SYNC")


# ObsessionDB accepts MODIFY COLUMN ... EPHEMERAL <default> without changing the
# default (https://github.com/obsessiondb/chkit/issues/285), so there the wait
# fails as it should. The verify job runs this against ClickHouse.
@pytest.mark.skipif(_ON_OBSESSIONDB, reason="ObsessionDB ignores EPHEMERAL default changes (#285)")
def test_an_ephemeral_default_change_passes_the_wait_once_every_replica_stores_it(
    ch_client: Any,
) -> None:
    client = ch_client._client
    live = _LiveClient(client)
    db = client.database
    name = f"{create_prefix('defwait_py_eph')}t"
    qualified = f"{quote_ident(db)}.{quote_ident(name)}"
    key = f"table:{db}.{name}:column:raw"
    try:
        client.command(
            f"CREATE TABLE {qualified} (id UInt32, raw String EPHEMERAL) ENGINE = MergeTree ORDER BY id"
        )
        wait_for_ddl_propagation(live, "create_table", f"table:{db}.{name}")
        for statement in (
            f"ALTER TABLE {qualified} MODIFY COLUMN `raw` String EPHEMERAL 'seed';",
            f"ALTER TABLE {qualified} MODIFY COLUMN `raw` String EPHEMERAL;",
            f"ALTER TABLE {qualified} MODIFY COLUMN `raw` String EPHEMERAL concat('se', 'ed');",
        ):
            client.command(statement)
            wait_for_ddl_propagation(live, "alter_table_modify_column", key, statement=statement)
        for replica in _every_replica(
            live,
            "default_kind, default_expression",
            f"database = '{db}' AND table = '{name}' AND name = 'raw'",
        ):
            assert replica == [
                {"default_kind": "EPHEMERAL", "default_expression": "concat('se', 'ed')"}
            ]
    finally:
        client.command(f"DROP TABLE IF EXISTS {qualified} SYNC")


def _every_replica(live: _LiveClient, fields: str, where: str) -> list[list[dict[str, Any]]]:
    """``fields`` of the rows matching ``where``, one sorted list per replica."""
    fanout = resolve_replica_fanout(live)
    source = all_replicas(fanout, "system.columns") if fanout else "system.columns"
    first = fields.split(",", maxsplit=1)[0]
    rows = live.query(
        f"SELECT hostName() AS replica, {fields} FROM {source} WHERE {where} "
        f"ORDER BY replica, {first}"
    ).rows
    replicas = list(dict.fromkeys(row["replica"] for row in rows))
    assert len(replicas) == (fanout.replicas if fanout else 1)
    return [
        [{k: v for k, v in row.items() if k != "replica"} for row in rows if row["replica"] == replica]
        for replica in replicas
    ]
