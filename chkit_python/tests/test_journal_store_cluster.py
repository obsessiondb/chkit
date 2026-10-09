"""Cluster-mode SQL rewrites in :class:`chkit.cli.journal_store.JournalStore`.

These tests exercise the SQL strings the store issues without needing a live
ClickHouse — we stub the client, capture ``execute`` calls, and assert the
resulting DDL. Behavioral parity with TS ``runtime/journal-store.ts``.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

from chkit.cli.journal_store import JournalStore
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig

_REPLICATED_ENGINE = (
    "ReplicatedReplacingMergeTree("
    "'/clickhouse/tables/{uuid}/chkit_journal', "
    "'{shard}_{replica}', applied_at)"
)


def _stub_store(cluster: str | None) -> tuple[JournalStore, MagicMock]:
    fake = MagicMock()
    cfg = ChxResolvedClickHouseConfig(
        url="http://localhost:8123",
        username="default",
        password="",
        database="default",
        secure=False,
        cluster=cluster,
    )
    client = ClickHouseClient(fake, cfg)
    return JournalStore(client, cluster=cluster), fake


# ---------- CREATE TABLE ----------


def test_create_table_uses_replicated_engine_and_on_cluster_when_cluster_set() -> None:
    store, _fake = _stub_store("prod")
    sql = store._create_table_sql()
    assert " ON CLUSTER 'prod' " in sql
    assert _REPLICATED_ENGINE in sql
    assert "ReplacingMergeTree(applied_at)" not in sql


def test_create_table_keeps_plain_engine_when_cluster_absent() -> None:
    store, _fake = _stub_store(None)
    sql = store._create_table_sql()
    assert "ON CLUSTER" not in sql
    assert "ENGINE = ReplacingMergeTree(applied_at)" in sql


def test_create_table_uses_macro_form_when_cluster_is_macro() -> None:
    store, _fake = _stub_store("{cluster}")
    sql = store._create_table_sql()
    assert " ON CLUSTER '{cluster}' " in sql


# ---------- ALTER TABLE (schema upgrade path) ----------


def test_ensure_schema_upgraded_stamps_on_cluster_on_both_alter_statements() -> None:
    # Cluster-mode ALTERs must carry ON CLUSTER so every replica converges on
    # the new column set in the same DDL round-trip. This is the TS parity
    # guarantee — if either ALTER goes out un-clustered, that node's journal
    # diverges silently.
    store, fake = _stub_store("prod-eu-1")
    store._ensure_schema_upgraded()

    executed = _captured_sql(fake)
    assert len(executed) == 2
    for sql in executed:
        assert sql.startswith("ALTER TABLE _chkit_migrations ON CLUSTER 'prod-eu-1'")
        assert "ADD COLUMN IF NOT EXISTS" in sql
    assert "migration_completed" in executed[0]
    assert "operations" in executed[1]


def test_ensure_schema_upgraded_omits_on_cluster_when_no_cluster() -> None:
    store, fake = _stub_store(None)
    store._ensure_schema_upgraded()

    for sql in _captured_sql(fake):
        assert "ON CLUSTER" not in sql


def _captured_sql(fake: Any) -> list[str]:
    """Extract the SQL string from each ``execute`` call on the fake client."""
    calls: list[str] = []
    for call in fake.command.call_args_list:
        if call.args:
            calls.append(str(call.args[0]))
    # ``ClickHouseClient.execute`` delegates to the underlying client's
    # ``command``; older code paths may go through other names — normalise.
    if not calls:
        for call in fake.query.call_args_list:
            if call.args:
                calls.append(str(call.args[0]))
    return calls
