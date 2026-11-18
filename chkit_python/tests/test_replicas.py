"""Reads across every replica of a multi-replica target (#265).

Port of ``packages/clickhouse/src/replicas.test.ts`` plus the journal cases of
``packages/cli/src/test/runtime/journal-store.test.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from chkit.cli.journal_store import JournalStore
from chkit.clickhouse.ddl_propagation import wait_for_ddl_propagation
from chkit.clickhouse.replicas import (
    ReplicaAccess,
    ReplicaFanout,
    probe_replica_access,
    resolve_replica_fanout,
    resolve_replica_fanout_or_raise,
)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("chkit.clickhouse.ddl_propagation.time.sleep", lambda _: None)


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
        if "_chkit_migrations" in sql and "system.tables" not in sql:
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


class _Failing:
    def __init__(self, message: str) -> None:
        self.message = message

    def query(self, sql: str) -> _Result:
        raise RuntimeError(self.message)


def test_probe_replica_access_reads_every_replica_strictly_and_fans_out_even_to_one_host() -> None:
    client = _ReplicaClient([1], replicas=1)

    assert probe_replica_access(client) == ReplicaAccess(
        kind="fanout", fanout=ReplicaFanout(cluster="default", replicas=1)
    )
    assert (
        "FROM clusterAllReplicas('default', system.one) SETTINGS skip_unavailable_shards = 0"
        in client.queries[0]
    )


def test_probe_replica_access_reports_a_denied_or_missing_cluster_or_no_count_as_partial() -> None:
    denied = "Code: 497. DB::Exception: Not enough privileges. (ACCESS_DENIED)"
    missing = "Requested cluster 'default' not found. (CLUSTER_DOESNT_EXIST)"

    class _Empty:
        def query(self, sql: str) -> _Result:
            return _Result([])

    assert probe_replica_access(_Failing(denied)) == ReplicaAccess(
        kind="partial", reason=f"the user may not read every replica ({denied})"
    )
    assert probe_replica_access(_Failing(missing)) == ReplicaAccess(
        kind="partial", reason="the cluster default does not exist, so not every replica can be read"
    )
    assert probe_replica_access(_Empty()) == ReplicaAccess(
        kind="partial", reason="the replica probe of cluster default returned no replica count"
    )
    # The lenient and strict fan-out helpers keep their single-replica fallback.
    assert resolve_replica_fanout_or_raise(_Failing(denied)) is None


# Two replicas, one unavailable: a probe that skipped it would count one host
# and pass for a single-node target.
def test_probe_replica_access_raises_when_a_replica_does_not_answer() -> None:
    class _OneDown:
        def query(self, sql: str) -> _Result:
            if "skip_unavailable_shards = 0" in sql:
                msg = "Code: 279. DB::NetException: All connection tries failed. (ALL_CONNECTION_TRIES_FAILED)"
                raise RuntimeError(msg)
            return _Result([{"replicas": 1}])

    with pytest.raises(RuntimeError, match="ALL_CONNECTION_TRIES_FAILED"):
        probe_replica_access(_OneDown())


@dataclass
class _ColumnReplicaClient(_ReplicaClient):
    """A column wait reads every replica's definition: one row per replica."""

    def query(self, sql: str) -> _Result:
        result = super().query(sql)
        if "system.columns" not in sql:
            return result
        column = {"type": "String", "default_kind": "", "default_expression": ""}
        count = int(result.rows[0]["replicas"])
        return _Result([{"replica": f"r{i}", **column} for i in range(1, count + 1)])


def test_keeps_waiting_while_only_one_of_two_replicas_shows_an_added_column() -> None:
    client = _ColumnReplicaClient([1, 1, 2])

    wait_for_ddl_propagation(client, "alter_table_add_column", "table:app.events:column:c1")

    polls = [q for q in client.queries if "system.columns" in q]
    assert len(polls) == 3
    assert "clusterAllReplicas('default', system.columns)" in polls[0]


def test_waits_until_every_replica_stores_the_same_dictionary_uuid_after_a_password_only_replace() -> None:
    """A replace leaves the row in place. The redacted definition can already match
    while one replica still has the previous uuid."""
    queries: list[str] = []
    visible = [{"replicas": 2, "agreed": 0}, {"replicas": 2, "agreed": 1}]

    class _Catalog:
        def query(self, sql: str) -> _Result:
            queries.append(sql)
            if "system.one" in sql:
                return _Result([{"replicas": 2}])
            return _Result([visible[min(len(queries) - 2, len(visible) - 1)]])

    wait_for_ddl_propagation(_Catalog(), "create_dictionary", "dictionary:app.users_dict")

    polls = [query for query in queries if "system.tables" in query]
    assert len(polls) == 2
    assert "clusterAllReplicas('default', system.tables)" in polls[0]
    assert "engine = 'Dictionary'" in polls[0]
    assert "min(uuid) = max(uuid)" in polls[0]
    assert "toUUID('00000000-0000-0000-0000-000000000000')" in polls[0]
    assert "create_table_query" not in polls[0]
    assert "system.dictionaries" not in polls[0]


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


def test_waits_until_every_replica_lists_the_journal_table_before_reading_it() -> None:
    client = _ReplicaClient([1, 2])
    real_query = client.query

    def query(sql: str) -> _Result:
        if sql.startswith("SELECT currentDatabase()"):
            client.queries.append(sql)
            return _Result([{"database": "default"}])
        if "LIMIT 0" in sql:
            client.queries.append(sql)
            return _Result([])
        return real_query(sql)

    client.query = query  # type: ignore[method-assign]
    store = JournalStore(client)  # type: ignore[arg-type]

    store.read_migration_state("m.sql")

    table_polls = [i for i, q in enumerate(client.queries) if "system.tables" in q]
    first_read = next(i for i, q in enumerate(client.queries) if "name = 'm.sql'" in q)
    assert len(table_polls) == 2
    assert first_read > table_polls[-1]
