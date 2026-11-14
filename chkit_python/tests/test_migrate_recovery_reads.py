"""Explicit recovery reads must not mistake cached journal absence for a first run."""

from __future__ import annotations

import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from chkit import __version__
from chkit.cli.commands import migrate as migrate_module
from chkit.cli.commands.migrate_apply import ApplyMigrationInput, apply_migration
from chkit.cli.commands.migrate_cancellation import FreshRecoveryClient, RecoveryObligation
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.commands.migrate_lock import LockTarget
from chkit.cli.commands.migrate_query_intents import (
    QueryIdentity,
    QueryRecovery,
    QueryTarget,
    QueryTracker,
)
from chkit.cli.journal_store import JournalStore
from chkit.cli.migration_store import checksum_sql
from chkit.clickhouse.client import QueryResult
from chkit.clickhouse.replicas import ReplicaFanout, resolve_replica_fanout_or_raise
from chkit.core.sql_fingerprint import statement_fingerprint

FORWARD = "INSERT INTO app.events SELECT 1;"
SQL = "-- operation: sql_statement key=statement:0 risk=safe\n-- before-retry: CREATE OR REPLACE TABLE app.events AS app.events\n" + FORWARD + "\n"
SERVER = "00000000-0000-4000-8000-000000000003"
UUID = "00000000-0000-4000-8000-000000000002"
TABLE = QueryTarget("app", "events", UUID, "MergeTree")
IDENTITY = QueryIdentity(1, "writer", [SERVER], "declared")


@pytest.mark.parametrize("explicit_recovery", [False, True])
def test_journal_resume_uses_fresh_reads_only_for_explicit_recovery(
    explicit_recovery: bool, tmp_path: Path,
) -> None:
    events: list[str] = []
    old = {"name": "m.sql", "applied_at": "2026-11-12 00:00:00.000", "checksum": checksum_sql(SQL),
           "chkit_version": __version__, "migration_completed": 0,
           "operations": json.dumps([{"operation_index": 0, "operation_key": "statement:0", "operation_type": "sql_statement", "query_id": "", "status": "started", "started_at": "2026-11-12 00:00:00.000", "finished_at": None, "last_error": ""}]),
           "operation_fingerprints": json.dumps([statement_fingerprint(FORWARD)])}

    class Client:
        def __init__(self) -> None:
            self.rows = 5
            self.checksum = ""

        def execute(self, sql: str, settings: dict[str, Any] | None = None) -> None:
            if "__chkit_migrate_query__" in sql:
                match = re.search(r", '((?:[^'\\]|\\.)*)', '.*', false, \[\] SETTINGS", sql)
                self.checksum = re.sub(r"\\(.)", r"\1", match[1]) if match else ""

        def read(self, sql: str, fresh: bool) -> QueryResult:
            rows: list[dict[str, Any]] = []
            if sql == "SELECT currentDatabase() AS database":
                rows = [{"database": "app"}]
            elif sql.startswith("SELECT name, toString(applied_at)"):
                events.append("fresh-started" if fresh else "cached-null")
                rows = [old] if fresh else []
            elif sql.startswith("SELECT checksum FROM"):
                rows = [{"checksum": self.checksum}]
            elif "system.tables" in sql:
                rows = [{"server_uuid": SERVER, "principal": "writer", "uuid": UUID, "engine": "MergeTree", "dependencies": "[]"}]
            return QueryResult(column_names=list(rows[0]) if rows else [], rows=rows)

        def query(self, sql: str, settings: dict[str, Any] | None = None) -> QueryResult:
            return self.read(sql, fresh=False)

        def query_control(self, sql: str, timeout_ms: float, **kwargs: Any) -> QueryResult:
            return self.read(sql, fresh=True)

        def execute_tracked(self, sql: str, check: Any, before: Any, settings: dict[str, Any] | None = None) -> None:
            check()
            before()
            check()
            if sql.startswith("CREATE OR REPLACE"):
                events.append("compensation")
                self.rows = 0
            else:
                events.append("forward")
                self.rows += 200

    raw = Client()
    client = FreshRecoveryClient(raw) if explicit_recovery else raw

    def settled(_table: Any) -> Any:
        events.append("settled")
        return TABLE

    lock = SimpleNamespace(claim_id="00000000-0000-4000-8000-000000000005", assert_held=lambda: None)
    tracker = QueryTracker(client, LockTarget("app", "_chkit_migrations", None), IDENTITY, cast(Any, lock),
                           QueryRecovery([TABLE], settled, (),
                                         (RecoveryObligation("m.sql", 0, statement_fingerprint(FORWARD), TABLE),)))
    (tmp_path / "m.sql").write_text(SQL)
    runtime = SimpleNamespace(run_on_before_apply=lambda ctx: ctx.statements, run_on_after_apply=lambda ctx: None)
    apply_migration(ApplyMigrationInput(cast(Any, client), JournalStore(cast(Any, client)), cast(Any, runtime),
                                       cast(Any, SimpleNamespace(clickhouse=None)), cast(Any, None), tmp_path,
                                       "m.sql", None, lambda _: None, query_tracker=tracker))
    assert raw.rows == (200 if explicit_recovery else 205)
    assert [event for event in events if event in {"compensation", "settled", "forward"}] == (
        ["compensation", "settled", "forward"] if explicit_recovery else ["forward"]
    )
    assert ("cached-null" in events) != explicit_recovery


def test_fresh_recovery_wraps_heartbeat_clones_and_preserves_bound_methods() -> None:
    calls: list[tuple[str, str, Any]] = []

    class Client:
        def __init__(self, name: str) -> None:
            self.name = name

        def query(self, _sql: str) -> None:
            raise AssertionError("ordinary query must not run")

        def query_control(self, sql: str, timeout_ms: float, **kwargs: Any) -> str:
            assert timeout_ms == 30_000
            calls.append((self.name, sql, kwargs.get("settings")))
            return self.name

        def open_concurrent(self) -> Client:
            assert self.name == "parent"
            return Client("clone")

        def execute(self, sql: str) -> None:
            calls.append((self.name, sql, None))

        def close(self) -> None:
            calls.append((self.name, "close", None))

    client = FreshRecoveryClient(Client("parent"))
    assert client.query("journal", {"max_result_rows": 1, "skip_unavailable_shards": 1}) == "parent"
    heartbeat = client.open_concurrent()
    assert heartbeat.query("claim", {"skip_unavailable_shards": 1}) == "clone"
    client.execute("unchanged user SQL")
    heartbeat.execute("unchanged heartbeat write")
    heartbeat.close()
    client.close()
    assert calls == [("parent", "journal", {"max_result_rows": 1, "skip_unavailable_shards": 0}),
                     ("clone", "claim", {"skip_unavailable_shards": 0}),
                     ("parent", "unchanged user SQL", None), ("clone", "unchanged heartbeat write", None),
                     ("clone", "close", None), ("parent", "close", None)]


def test_explicit_recovery_refuses_missing_control_capability() -> None:
    with pytest.raises(MigrateError, match="bounded fresh control reads"):
        FreshRecoveryClient(SimpleNamespace(query=lambda _: []))


def test_failed_strict_read_never_falls_back_to_ordinary_query() -> None:
    def ordinary(_sql: str) -> None:
        raise AssertionError("ordinary path used")

    def control(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("truncated control response")

    client = FreshRecoveryClient(SimpleNamespace(query=ordinary, query_control=control))
    with pytest.raises(RuntimeError, match="truncated control response"):
        client.query("journal")


def test_explicit_recovery_refuses_raw_async_status_without_changing_ordinary_status() -> None:
    calls: list[str] = []

    def status(query_id: str) -> str:
        calls.append(query_id)
        return "unknown"

    raw = SimpleNamespace(query_control=lambda *args, **kwargs: [], query_status=status)
    with pytest.raises(MigrateError, match="historical async"):
        FreshRecoveryClient(raw).query_status("old-async")
    assert calls == []
    assert raw.query_status("old-async") == "unknown"
    assert calls == ["old-async"]


def test_command_preflight_rejects_historical_async_before_kill_or_handoff(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    writes: list[str] = []
    raw = SimpleNamespace(query_control=lambda *args, **kwargs: [], execute_tracked=lambda *args: None,
                          execute=writes.append)
    store = SimpleNamespace(lock_target=lambda: ("app", "_chkit_migrations", None),
                            read_migration_state=lambda _: SimpleNamespace(operations=[SimpleNamespace(status="started", query_id="old-async")]))
    monkeypatch.setattr(migrate_module, "resolve_query_identity", lambda *args: IDENTITY)
    monkeypatch.setattr(migrate_module, "prepare_cancellation", lambda *args: SimpleNamespace(claim=UUID))
    runner = migrate_module._MigrateLockRunner(raw_client=FreshRecoveryClient(raw), journal_store=cast(Any, store),
                                             holder=migrate_module._LockHolder(), break_lock=UUID, json_mode=True,
                                             cancel_queries=True, migrations_dir=tmp_path)
    (tmp_path / "m.sql").write_text(SQL)
    with pytest.raises(MigrateError, match="historical async attempt"):
        runner(lambda: writes.append("apply"), ["m.sql"])
    assert writes == []


def test_explicit_legacy_fanout_refuses_profile_hidden_unavailable_member() -> None:
    queries: list[str] = []

    def ordinary(_sql: str) -> QueryResult:
        return QueryResult(column_names=["replicas"], rows=[{"replicas": 1}])

    def control(sql: str, _timeout: float, **kwargs: Any) -> QueryResult:
        queries.append(sql)
        if kwargs["settings"].get("skip_unavailable_shards") != 0:
            return ordinary(sql)
        raise RuntimeError("replica unavailable")

    raw = SimpleNamespace(query=ordinary, query_control=control)
    assert resolve_replica_fanout_or_raise(raw, "declared") is None
    with pytest.raises(RuntimeError, match="replica unavailable"):
        resolve_replica_fanout_or_raise(FreshRecoveryClient(raw), "declared")
    assert len(queries) == 1
    assert "count(DISTINCT hostName())" in queries[0]


@pytest.mark.parametrize("legacy", ["same hostname", "denied discovery"])
def test_attested_journal_coverage_never_degrades_to_local_reads(legacy: str) -> None:
    reads: list[str] = []

    def control(sql: str, _timeout: float, **kwargs: Any) -> QueryResult:
        reads.append(sql)
        rows: list[dict[str, Any]] = []
        if "count(DISTINCT hostName())" in sql and "system.one" in sql:
            if legacy == "denied discovery":
                raise RuntimeError("ACCESS_DENIED")
            rows = [{"replicas": 1}]
        elif sql == "SELECT currentDatabase() AS database":
            rows = [{"database": "app"}]
        elif sql.startswith("SELECT name, toString("):
            assert "clusterAllReplicas('declared'" in sql, "unsafe local journal read"
            rows = [{"name": "m.sql", "applied_at": "2026-11-12 00:00:00.000", "checksum": "c", "chkit_version": __version__, "migration_completed": 0, "operations": "[]", "operation_fingerprints": "[]"}]
        elif "system.columns" in sql:
            rows = [{"replicas": 2, "x": 1}]
        elif "system.tables" in sql:
            rows = [{"engine": "MergeTree", "x": 1}]
        return QueryResult(column_names=list(rows[0]) if rows else [], rows=rows)

    raw = SimpleNamespace(query_control=control, execute=lambda *_args: None)
    store = JournalStore(cast(Any, FreshRecoveryClient(raw)), fanout_override=ReplicaFanout("declared", 2))
    state = store.read_migration_state("m.sql")
    assert state is not None
    assert state.name == "m.sql"
    assert any("clusterAllReplicas('declared', currentDatabase()" in sql for sql in reads)


def test_attested_single_node_journal_coverage_skips_legacy_discovery() -> None:
    def control(sql: str, _timeout: float, **kwargs: Any) -> QueryResult:
        assert "system.one" not in sql, "legacy discovery must not run"
        rows = [{"engine": "MergeTree"}] if "system.tables" in sql else []
        return QueryResult(column_names=list(rows[0]) if rows else [], rows=rows)

    raw = SimpleNamespace(query_control=control, execute=lambda *_args: None)
    assert JournalStore(cast(Any, FreshRecoveryClient(raw)), fanout_override=ReplicaFanout("declared", 1)).read_migration_state("m.sql") is None


def test_changed_initial_identity_refuses_before_takeover(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    writes: list[str] = []

    def control(_sql: str, _timeout: float, **kwargs: Any) -> QueryResult:
        return QueryResult(column_names=[], rows=[{"server_uuid": UUID, "principal": "writer"}])

    raw = SimpleNamespace(query_control=control, execute_tracked=lambda *args: None, execute=writes.append)
    store = SimpleNamespace(lock_target=lambda: ("app", "_chkit_migrations", None))
    monkeypatch.setattr(migrate_module, "resolve_query_identity", lambda *args: pytest.fail("initial identity must be reused"))
    runner = migrate_module._MigrateLockRunner(raw_client=FreshRecoveryClient(raw), journal_store=cast(Any, store),
                                             holder=migrate_module._LockHolder(), break_lock=UUID, json_mode=True,
                                             cancel_queries=True, migrations_dir=tmp_path, initial_identity=IDENTITY)
    with pytest.raises(MigrateError, match="changed"):
        runner(lambda: writes.append("apply"), ["m.sql"])
    assert writes == []
