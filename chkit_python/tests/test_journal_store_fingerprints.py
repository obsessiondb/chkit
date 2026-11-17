"""Statement fingerprints in :class:`chkit.cli.journal_store.JournalStore` (#599).

Fingerprints live in a column of their own, which older releases never name:
their writes leave it ``[]``. Same as the TS ``statement fingerprints (#599)``
journal-store tests.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pytest

from chkit.cli.journal_store import JournalStore, MigrationRowState, OperationState
from chkit.clickhouse.replicas import ReplicaFanout

pytestmark = pytest.mark.usefixtures("single_replica")

FINGERPRINT_PROBE = "SELECT operation_fingerprints FROM _chkit_migrations LIMIT 0"


@dataclass
class _Result:
    rows: list[dict[str, Any]]


@dataclass
class _Client:
    rows: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])
    query_error: Callable[[str, list[str]], Exception | None] = lambda _sql, _executed: None
    execute_error: Callable[[str], Exception | None] = lambda _sql: None
    queries: list[str] = field(default_factory=list[str])
    executed: list[str] = field(default_factory=list[str])

    def query(self, sql: str) -> _Result:
        self.queries.append(sql)
        error = self.query_error(sql, self.executed)
        if error is not None:
            raise error
        if "WHERE name = 'm.sql'" not in sql:
            return _Result([])
        # A read that does not select the column does not get it.
        if "operation_fingerprints" in sql:
            return _Result(self.rows)
        return _Result(
            [{k: v for k, v in row.items() if k != "operation_fingerprints"} for row in self.rows]
        )

    def execute(self, sql: str) -> None:
        self.executed.append(sql)
        error = self.execute_error(sql)
        if error is not None:
            raise error


def _clickhouse_error(code: int, name: str) -> Exception:
    return Exception(f"Code: {code}. DB::Exception: something. ({name})")


def _row(operations: list[dict[str, Any]], fingerprints: Any) -> dict[str, Any]:
    return {
        "name": "m.sql",
        "applied_at": "2026-11-09 12:00:00.000",
        "checksum": "abc",
        "chkit_version": "0.0.0",
        "migration_completed": False,
        "operations": json.dumps(operations),
        "operation_fingerprints": json.dumps(fingerprints),
    }


def _tuple(index: int) -> dict[str, Any]:
    return {
        "operation_index": index,
        "operation_key": f"statement:{index}",
        "operation_type": "sql_statement",
        "query_id": "",
        "status": "completed",
        "started_at": "2026-11-09 12:00:00.000",
        "finished_at": "2026-11-09 12:00:00.000",
        "last_error": "",
    }


def _state(fingerprints: list[str]) -> MigrationRowState:
    return MigrationRowState(
        name="m.sql",
        applied_at="2026-11-09T12:00:01.000",
        checksum="abc",
        chkit_version="0.0.0",
        migration_completed=False,
        operations=[
            OperationState(
                operation_index=index,
                operation_key=f"statement:{index}",
                operation_type="sql_statement",
                query_id="",
                status="completed",
                started_at="2026-11-09T12:00:00.000",
                finished_at="2026-11-09T12:00:00.000",
                last_error="",
                fingerprint=fingerprint,
            )
            for index, fingerprint in enumerate(fingerprints)
        ],
    )


def _store(client: _Client) -> JournalStore:
    return JournalStore(client)  # type: ignore[arg-type]


def _no_column(sql: str, _executed: list[str]) -> Exception | None:
    return _clickhouse_error(47, "UNKNOWN_IDENTIFIER") if sql == FINGERPRINT_PROBE else None


def test_reads_one_fingerprint_per_operation_in_order() -> None:
    client = _Client(rows=[_row([_tuple(0), _tuple(1)], ["v1:a", "v1:b"])])
    state = _store(client).read_migration_state("m.sql")
    assert state is not None
    assert [op.fingerprint for op in state.operations] == ["v1:a", "v1:b"]
    read = next(sql for sql in client.queries if "name = 'm.sql'" in sql)
    assert "toJSONString(operation_fingerprints) AS operation_fingerprints" in read


def test_a_row_an_older_release_wrote_has_no_fingerprints() -> None:
    client = _Client(rows=[_row([_tuple(0), _tuple(1)], [])])
    state = _store(client).read_migration_state("m.sql")
    assert state is not None
    assert [op.fingerprint for op in state.operations] == ["", ""]


def test_writes_the_fingerprints_next_to_the_operations() -> None:
    client = _Client()
    _store(client).write_migration_state(_state(["v1:a", "v1:'b"]))
    insert = next(sql for sql in client.executed if sql.startswith("INSERT INTO"))
    assert "migration_completed, operations, operation_fingerprints) VALUES" in insert
    assert insert.endswith(", ['v1:a','v1:\\'b'])")
    assert not any(sql.startswith("ALTER TABLE") for sql in client.executed)


def test_a_journal_without_the_column_is_read_without_fingerprints_and_not_altered() -> None:
    client = _Client(rows=[_row([_tuple(0)], ["v1:a"])], query_error=_no_column)
    state = _store(client).read_migration_state("m.sql")
    assert state is not None
    assert [op.fingerprint for op in state.operations] == [""]
    read = next(sql for sql in client.queries if "name = 'm.sql'" in sql)
    assert "operation_fingerprints" not in read
    assert [sql for sql in client.executed if not sql.startswith("SYSTEM SYNC REPLICA")] == []


def test_the_first_write_adds_the_column_to_a_journal_an_older_release_created() -> None:
    client = _Client(
        query_error=lambda sql, executed: (
            _clickhouse_error(47, "UNKNOWN_IDENTIFIER")
            if sql == FINGERPRINT_PROBE
            and not any(command.startswith("ALTER TABLE") for command in executed)
            else None
        )
    )
    store = _store(client)
    store.read_journal()
    store.write_migration_state(_state(["v1:a"]))
    writes = [sql for sql in client.executed if not sql.startswith("SYSTEM SYNC REPLICA")]
    assert writes[0] == (
        "ALTER TABLE `default`._chkit_migrations ADD COLUMN IF NOT EXISTS "
        "operation_fingerprints Array(String) DEFAULT []"
    )
    assert writes[1].endswith(", ['v1:a'])")


def test_a_user_that_cannot_alter_the_journal_still_writes_without_fingerprints() -> None:
    client = _Client(
        query_error=_no_column,
        execute_error=lambda sql: (
            _clickhouse_error(497, "ACCESS_DENIED") if sql.startswith("ALTER TABLE") else None
        ),
    )
    store = _store(client)
    store.write_migration_state(_state(["v1:a"]))
    store.write_migration_state(_state(["v1:a"]))
    inserts = [sql for sql in client.executed if sql.startswith("INSERT INTO")]
    assert len(inserts) == 2
    assert all("operation_fingerprints" not in sql for sql in inserts)
    # The ALTER is tried once per run.
    assert len([sql for sql in client.executed if sql.startswith("ALTER TABLE")]) == 1


def test_a_run_that_cannot_add_the_column_says_once_on_stderr_that_it_records_no_fingerprints(
    capsys: pytest.CaptureFixture[str],
) -> None:
    denied = Exception(
        "u: Not enough privileges. To execute this query, it's necessary to have the grant "
        "ALTER ADD COLUMN(operation_fingerprints) ON db._chkit_migrations. "
    )
    client = _Client(
        query_error=_no_column,
        execute_error=lambda sql: denied if sql.startswith("ALTER TABLE") else None,
    )
    store = _store(client)
    store.write_migration_state(_state(["v1:a"]))
    store.write_migration_state(_state(["v1:a"]))
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == (
        "⚠ Could not add the operation_fingerprints column to _chkit_migrations (u: Not "
        "enough privileges. To execute this query, it's necessary to have the grant ALTER "
        "ADD COLUMN(operation_fingerprints) ON db._chkit_migrations), so this run records "
        "no statement fingerprints: a later --retry or resume checks the statements it "
        'completes by position and "-- operation:" marker only, not by their SQL. The next '
        "migration applied by a user that can ALTER _chkit_migrations adds the column.\n"
    )


def test_a_run_that_cannot_add_the_column_logs_why_with_chkit_debug(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "chkit.cli.journal_store.debug",
        lambda category, message, detail=None: logged.append((category, message)),
    )
    client = _Client(
        query_error=_no_column,
        execute_error=lambda sql: (
            _clickhouse_error(497, "ACCESS_DENIED") if sql.startswith("ALTER TABLE") else None
        ),
    )
    _store(client).write_migration_state(_state(["v1:a"]))
    assert (
        "journal",
        "could not add operation_fingerprints — recording no fingerprints: "
        "Code: 497. DB::Exception: something. (ACCESS_DENIED)",
    ) in logged


def test_a_run_that_has_the_column_says_nothing_on_stderr(
    capsys: pytest.CaptureFixture[str],
) -> None:
    client = _Client(
        execute_error=lambda sql: (
            _clickhouse_error(497, "ACCESS_DENIED") if sql.startswith("ALTER TABLE") else None
        ),
    )
    _store(client).write_migration_state(_state(["v1:a"]))
    assert capsys.readouterr().err == ""


def test_a_probe_that_fails_for_another_reason_stops_the_read() -> None:
    """Fingerprints that were recorded are never read as missing: only a server
    that says the column is missing switches to the old format."""
    client = _Client(
        rows=[_row([_tuple(0)], ["v1:a"])],
        query_error=lambda sql, _executed: (
            Exception("HTTP 503 Service Unavailable") if sql == FINGERPRINT_PROBE else None
        ),
    )
    with pytest.raises(Exception, match="HTTP 503"):
        _store(client).read_migration_state("m.sql")


def test_a_read_that_fails_on_the_column_is_not_retried_without_it() -> None:
    client = _Client(
        rows=[_row([_tuple(0)], ["v1:a"])],
        query_error=lambda sql, _executed: (
            _clickhouse_error(47, "UNKNOWN_IDENTIFIER")
            if "name = 'm.sql'" in sql and "operation_fingerprints" in sql
            else None
        ),
    )
    with pytest.raises(Exception, match="UNKNOWN_IDENTIFIER"):
        _store(client).read_migration_state("m.sql")


def test_an_insert_that_fails_on_the_column_is_not_written_again_without_it() -> None:
    client = _Client(
        execute_error=lambda sql: (
            _clickhouse_error(16, "NO_SUCH_COLUMN_IN_TABLE")
            if "operation_fingerprints) VALUES" in sql
            else None
        )
    )
    with pytest.raises(Exception, match="NO_SUCH_COLUMN_IN_TABLE"):
        _store(client).write_migration_state(_state(["v1:a"]))
    assert len([sql for sql in client.executed if sql.startswith("INSERT INTO")]) == 1


@dataclass
class _ReplicatedClient:
    """Two replicas; ``with_column`` is how many have the column on each poll."""

    with_column: list[int]
    queries: list[str] = field(default_factory=list[str])
    polls: int = 0

    def query(self, sql: str) -> _Result:
        self.queries.append(sql)
        if "system.one" in sql:
            return _Result([{"replicas": 2}])
        if "currentDatabase() AS database" in sql:
            return _Result([{"database": "default"}])
        if "system.columns" in sql:
            seen = self.with_column[min(self.polls, len(self.with_column) - 1)]
            self.polls += 1
            return _Result([{"replicas": seen}])
        if "system.tables" in sql:
            return _Result([{"replicas": 2}])
        return _Result([])

    def execute(self, sql: str) -> None:
        _ = sql


@pytest.fixture
def two_replicas(single_replica: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _ = single_replica  # replaced below
    fanout = ReplicaFanout(cluster="default", replicas=2)
    monkeypatch.setattr("chkit.clickhouse.ddl_propagation.resolve_replica_fanout", lambda *_: fanout)
    monkeypatch.setattr("chkit.cli.journal_store.resolve_replica_fanout_or_raise", lambda *_: fanout)


@pytest.mark.usefixtures("two_replicas")
def test_a_column_one_replica_has_is_waited_for_on_every_replica() -> None:
    client = _ReplicatedClient(with_column=[1, 1, 2])
    JournalStore(client, cluster="default").read_migration_state("m.sql")  # type: ignore[arg-type]
    read = next(sql for sql in client.queries if "name = 'm.sql'" in sql)
    assert "toJSONString(operation_fingerprints)" in read
    assert len([sql for sql in client.queries if "system.columns" in sql]) == 3


@pytest.mark.usefixtures("two_replicas")
def test_a_column_no_replica_has_is_read_as_missing() -> None:
    client = _ReplicatedClient(with_column=[0])
    JournalStore(client, cluster="default").read_migration_state("m.sql")  # type: ignore[arg-type]
    read = next(sql for sql in client.queries if "name = 'm.sql'" in sql)
    assert "operation_fingerprints" not in read


TABLES_PROBE = (
    "SELECT hostName() AS replica, create_table_query FROM "
    "clusterAllReplicas('default', system.tables)"
)


def _definition(fingerprints: bool) -> str:
    column = ", `operation_fingerprints` Array(String) DEFAULT []" if fingerprints else ""
    return (
        "CREATE TABLE default._chkit_migrations (`name` String, "
        f"`operations` Array(Tuple(operation_index Int32)) DEFAULT []{column}) "
        "ENGINE = ReplacingMergeTree(applied_at) ORDER BY name"
    )


@dataclass
class _DeniedColumnsClient:
    """Two replicas, for a user without SHOW COLUMNS on system.columns (#402).

    ``with_column[n]`` replicas define the column on the nth probe of
    system.tables; ``listed`` replicas list the journal.
    """

    with_column: list[int]
    listed: int = 2
    render: Callable[[bool], str] = _definition
    queries: list[str] = field(default_factory=list[str])
    executed: list[str] = field(default_factory=list[str])
    probes: int = 0

    def query(self, sql: str) -> _Result:
        self.queries.append(sql)
        if "currentDatabase() AS database" in sql:
            return _Result([{"database": "default"}])
        if TABLES_PROBE in sql:
            seen = self.with_column[min(self.probes, len(self.with_column) - 1)]
            self.probes += 1
            return _Result(
                [
                    {"replica": f"replica-{index}", "create_table_query": self.render(index < seen)}
                    for index in range(self.listed)
                ]
            )
        if "system.columns" in sql:
            raise Exception(
                "u: Not enough privileges. To execute this query, it's necessary to have "
                "the grant SHOW COLUMNS ON system.columns. "
            )
        if "system.tables" in sql:
            return _Result([{"replicas": 2}])
        if "WHERE name = 'm.sql'" in sql:
            row = _row([_tuple(0)], ["v1:a"])
            if "operation_fingerprints" not in sql:
                del row["operation_fingerprints"]
            return _Result([row])
        return _Result([])

    def execute(self, sql: str) -> None:
        self.executed.append(sql)


def _denied_store(client: _DeniedColumnsClient) -> JournalStore:
    return JournalStore(client, cluster="default")  # type: ignore[arg-type]


def _tables_probes(client: _DeniedColumnsClient) -> int:
    return len([sql for sql in client.queries if TABLES_PROBE in sql])


@pytest.fixture
def no_poll_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("chkit.cli.journal_store.RETRY_DELAY_SECONDS", 0)


@pytest.mark.usefixtures("two_replicas")
def test_without_system_columns_a_column_every_replica_has_is_read() -> None:
    client = _DeniedColumnsClient(with_column=[2])
    read = _denied_store(client).read_migration_state("m.sql")
    assert read is not None
    assert [op.fingerprint for op in read.operations] == ["v1:a"]
    assert _tables_probes(client) == 2


@pytest.mark.usefixtures("two_replicas")
@pytest.mark.parametrize(
    "render",
    [
        lambda fingerprints: (
            'CREATE TABLE "default"."_chkit_migrations" ("name" String'
            + (', "operation_fingerprints" Array(String) DEFAULT []' if fingerprints else "")
            + ') ENGINE = ReplacingMergeTree(applied_at) ORDER BY "name"'
        ),
        lambda fingerprints: (
            "CREATE TABLE default._chkit_migrations (`name` String"
            + (", operation_fingerprints Array(String) DEFAULT []" if fingerprints else "")
            + ") ENGINE = ReplacingMergeTree(applied_at) ORDER BY `name`"
        ),
    ],
    ids=["double_quotes", "bare"],
)
def test_without_system_columns_a_column_is_read_whatever_identifier_quoting(
    render: Callable[[bool], str],
) -> None:
    client = _DeniedColumnsClient(with_column=[2], render=render)
    store = _denied_store(client)
    read = store.read_migration_state("m.sql")
    store.write_migration_state(_state(["v1:a"]))
    assert read is not None
    assert [op.fingerprint for op in read.operations] == ["v1:a"]
    insert = next(sql for sql in client.executed if sql.startswith("INSERT INTO"))
    assert insert.endswith(", ['v1:a'])")


@pytest.mark.usefixtures("two_replicas")
def test_without_system_columns_a_comment_that_mentions_the_column_does_not_define_it() -> None:
    client = _DeniedColumnsClient(
        with_column=[2],
        render=lambda _fingerprints: (
            "CREATE TABLE default._chkit_migrations (`name` String COMMENT "
            "'`operation_fingerprints` Array(String)') ENGINE = "
            "ReplacingMergeTree(applied_at) ORDER BY name"
        ),
    )
    read = _denied_store(client).read_migration_state("m.sql")
    assert read is not None
    assert [op.fingerprint for op in read.operations] == [""]


@pytest.mark.usefixtures("two_replicas")
def test_without_system_columns_a_definition_chkit_cannot_read_stops_the_read() -> None:
    client = _DeniedColumnsClient(with_column=[2], render=lambda _fingerprints: "")
    with pytest.raises(
        RuntimeError,
        match=re.escape(
            "Cannot tell whether the journal table _chkit_migrations has the "
            "operation_fingerprints column: cannot read its definition on replica replica-0."
        ),
    ):
        _denied_store(client).read_migration_state("m.sql")


@pytest.mark.usefixtures("two_replicas", "no_poll_delay")
def test_without_system_columns_a_column_a_lagging_replica_lacks_is_waited_for() -> None:
    client = _DeniedColumnsClient(with_column=[1, 1, 2])
    read = _denied_store(client).read_migration_state("m.sql")
    assert read is not None
    assert [op.fingerprint for op in read.operations] == ["v1:a"]
    assert _tables_probes(client) == 3


@pytest.mark.usefixtures("two_replicas", "no_poll_delay")
def test_without_system_columns_the_writes_of_a_run_that_waited_keep_recording_fingerprints() -> (
    None
):
    client = _DeniedColumnsClient(with_column=[1, 2])
    _denied_store(client).write_migration_state(_state(["v1:a"]))
    assert not any(sql.startswith("ALTER TABLE") for sql in client.executed)
    insert = next(sql for sql in client.executed if sql.startswith("INSERT INTO"))
    assert insert.endswith(", ['v1:a'])")


@pytest.mark.usefixtures("two_replicas")
def test_without_system_columns_a_column_no_replica_has_is_read_as_missing() -> None:
    client = _DeniedColumnsClient(with_column=[0])
    read = _denied_store(client).read_migration_state("m.sql")
    assert read is not None
    assert [op.fingerprint for op in read.operations] == [""]
    read_sql = next(sql for sql in client.queries if "name = 'm.sql'" in sql)
    assert "operation_fingerprints" not in read_sql


@pytest.mark.usefixtures("two_replicas")
def test_without_system_columns_a_replica_that_does_not_list_the_journal_stops_the_read() -> None:
    client = _DeniedColumnsClient(with_column=[0], listed=1)
    with pytest.raises(
        RuntimeError,
        match=re.escape(
            "Cannot tell whether the journal table _chkit_migrations has the "
            "operation_fingerprints column: 1 of 2 replicas list it."
        ),
    ):
        _denied_store(client).read_migration_state("m.sql")


@pytest.mark.usefixtures("two_replicas", "no_poll_delay")
def test_without_system_columns_the_column_this_run_adds_is_waited_for_through_system_tables() -> (
    None
):
    client = _DeniedColumnsClient(with_column=[0, 1, 2])
    store = _denied_store(client)
    store.read_journal()
    store.write_migration_state(_state(["v1:a"]))
    assert any(sql.startswith("ALTER TABLE") for sql in client.executed)
    insert = next(sql for sql in client.executed if sql.startswith("INSERT INTO"))
    assert insert.endswith(", ['v1:a'])")
    assert _tables_probes(client) == 3
    assert len([sql for sql in client.queries if "system.columns" in sql]) == 1


@pytest.mark.usefixtures("two_replicas")
def test_a_system_columns_probe_that_fails_for_another_reason_stops_the_read() -> None:
    class _Unavailable(_ReplicatedClient):
        def query(self, sql: str) -> _Result:
            if "system.columns" in sql:
                raise Exception("HTTP 503 Service Unavailable")
            return super().query(sql)

    with pytest.raises(Exception, match="HTTP 503"):
        JournalStore(_Unavailable(with_column=[0]), cluster="default").read_migration_state(  # type: ignore[arg-type]
            "m.sql"
        )


def test_the_abandon_report_leaves_fingerprints_out() -> None:
    state = _state(["v1:a"])
    assert "fingerprint" not in state.operations[0].model_dump(by_alias=True)
