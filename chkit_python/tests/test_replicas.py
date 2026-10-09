"""Reads across every replica of a multi-replica target (#265).

Port of ``packages/clickhouse/src/replicas.test.ts`` plus the journal cases of
``packages/cli/src/test/runtime/journal-store.test.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from chkit.cli.journal_store import JournalStore
from chkit.clickhouse import ddl_propagation
from chkit.clickhouse.ddl_propagation import wait_for_ddl_propagation
from chkit.clickhouse.replicas import ReplicaFanout, resolve_replica_fanout


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ddl_propagation.time, "sleep", lambda _: None)


@dataclass
class _Result:
    rows: list[dict[str, Any]]


@dataclass
class _ReplicaClient:
    """Two replicas behind one endpoint; ``visible`` is how many replicas report
    the object on each successive poll."""

    visible: list[int]
    replicas: int = 2
    queries: list[str] = field(default_factory=list[str])

    def query(self, sql: str) -> _Result:
        self.queries.append(sql)
        if "system.one" in sql:
            return _Result([{"replicas": self.replicas}])
        if "_chkit_migrations" in sql:
            return _Result([])
        polls = sum(1 for q in self.queries if "system.columns" in q or "system.tables" in q)
        return _Result([{"replicas": self.visible[min(polls - 1, len(self.visible) - 1)]}])

    def execute(self, sql: str) -> None:
        self.queries.append(sql)


def test_reports_the_replicas_of_a_multi_replica_target_once_per_client() -> None:
    client = _ReplicaClient([2])

    assert resolve_replica_fanout(client) == ReplicaFanout(cluster="default", replicas=2)
    assert resolve_replica_fanout(client) == ReplicaFanout(cluster="default", replicas=2)
    assert sum(1 for q in client.queries if "system.one" in q) == 1


def test_falls_back_to_the_single_replica_path_when_the_cluster_cannot_be_queried() -> None:
    class _NoCluster:
        def query(self, sql: str) -> _Result:
            msg = "Requested cluster 'default' not found. (CLUSTER_DOESNT_EXIST)"
            raise RuntimeError(msg)

    assert resolve_replica_fanout(_NoCluster()) is None


def test_uses_the_configured_cluster_name() -> None:
    client = _ReplicaClient([2])

    assert resolve_replica_fanout(client, "prod") == ReplicaFanout(cluster="prod", replicas=2)
    assert "clusterAllReplicas('prod', system.one)" in client.queries[0]


def test_keeps_waiting_while_only_one_of_two_replicas_shows_an_added_column() -> None:
    client = _ReplicaClient([1, 1, 2])

    wait_for_ddl_propagation(client, "alter_table_add_column", "table:app.events:column:c1")

    polls = [q for q in client.queries if "system.columns" in q]
    assert len(polls) == 3
    assert "clusterAllReplicas('default', system.columns)" in polls[0]


def test_waits_until_no_replica_still_shows_a_dropped_column() -> None:
    client = _ReplicaClient([1, 0])

    wait_for_ddl_propagation(client, "alter_table_drop_column", "table:app.events:column:c1")

    assert len([q for q in client.queries if "system.columns" in q]) == 2


def _journal(replicas: int) -> tuple[JournalStore, _ReplicaClient]:
    client = _ReplicaClient([0], replicas=replicas)
    store = JournalStore(client)  # type: ignore[arg-type]
    store._bootstrapped = True  # pyright: ignore[reportPrivateUsage]
    return store, client


def test_read_migration_state_keeps_the_newest_version_from_any_replica() -> None:
    store, client = _journal(2)

    store.read_migration_state("m.sql")

    read = next(q for q in client.queries if "name = 'm.sql'" in q)
    assert "clusterAllReplicas('default', currentDatabase(), '_chkit_migrations')" in read
    assert "argMax(tuple(applied_at, checksum, chkit_version, migration_completed" in read
    assert "FINAL" not in read


def test_read_journal_keeps_the_newest_version_from_any_replica() -> None:
    store, client = _journal(2)

    store.read_journal()

    read = next(q for q in client.queries if "migration_completed = true" in q)
    assert "clusterAllReplicas(" in read
    assert "GROUP BY name" in read


def test_a_single_replica_keeps_the_final_read() -> None:
    store, client = _journal(1)

    store.read_migration_state("m.sql")

    read = next(q for q in client.queries if "name = 'm.sql'" in q)
    assert "FINAL" in read
    assert "clusterAllReplicas(" not in read
