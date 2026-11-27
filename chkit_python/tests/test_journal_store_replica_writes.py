"""Journal writes on a multi-replica target (#700).

A journal INSERT or ALTER that reaches a replica without the database is
retried by the client without it, so it must name the database and run only
once every replica has the journal.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest

from chkit.cli.journal_store import JournalStore, MigrationRowState

_UNKNOWN_DATABASE = "Code: 81. DB::Exception: Database app does not exist. (UNKNOWN_DATABASE)"
_UNKNOWN_IDENTIFIER = (
    "Code: 47. DB::Exception: Unknown expression identifier `operations`. (UNKNOWN_IDENTIFIER)"
)


@dataclass
class _Target:
    """Answers the replica probe with ``probe`` in turn (a str raises it, an
    int is the replica count, the last one repeats). ``legacy`` makes it a
    journal an older release created, without the per-operation columns."""

    probe: list[str | int]
    legacy: bool = False
    calls: list[str] = field(default_factory=list[str])
    probes: int = 0

    def __post_init__(self) -> None:
        self.upgraded = not self.legacy

    def execute(self, sql: str, settings: dict[str, Any] | None = None) -> None:
        self.calls.append(sql)
        if "ADD COLUMN IF NOT EXISTS operations " in sql:
            self.upgraded = True

    def query(self, sql: str, settings: dict[str, Any] | None = None) -> Any:
        self.calls.append(sql)
        if "system.one" in sql:
            answer = self.probe[min(self.probes, len(self.probe) - 1)]
            self.probes += 1
            if isinstance(answer, str):
                raise RuntimeError(answer)
            return SimpleNamespace(rows=[{"replicas": answer}])
        if sql.startswith("SELECT name, migration_completed, operations FROM") and not self.upgraded:
            raise RuntimeError(_UNKNOWN_IDENTIFIER)
        if sql.startswith("SELECT currentDatabase()"):
            return SimpleNamespace(rows=[{"database": "app"}])
        if "AS replicas" in sql:
            return SimpleNamespace(rows=[{"replicas": 2}])
        return SimpleNamespace(rows=[])


def _state() -> MigrationRowState:
    return MigrationRowState.model_validate(
        {
            "name": "m.sql",
            "appliedAt": "2026-11-10T12:00:00.000",
            "checksum": "cs",
            "chkitVersion": "v",
            "migrationCompleted": True,
            "operations": [],
        }
    )


def _is_journal_poll(sql: str) -> bool:
    return "clusterAllReplicas('default', system.tables)" in sql


def _is_write(sql: str) -> bool:
    return sql.startswith(("INSERT INTO", "ALTER TABLE"))


def _first(calls: list[str], prefix: str) -> int:
    return next(index for index, sql in enumerate(calls) if sql.startswith(prefix))


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("chkit.cli.journal_store.time.sleep", lambda _: None)


def test_a_replica_probe_that_fails_is_not_taken_for_a_single_replica() -> None:
    # The probe reached a replica without the new database yet.
    target = _Target(probe=[_UNKNOWN_DATABASE, 2])

    JournalStore(target).write_migration_state(_state())  # type: ignore[arg-type]

    polls = [index for index, sql in enumerate(target.calls) if _is_journal_poll(sql)]
    assert polls
    assert polls[0] < _first(target.calls, "INSERT INTO")


def test_a_replica_probe_that_keeps_failing_stops_the_write() -> None:
    target = _Target(probe=["Code: 159. DB::Exception: Timeout exceeded. (TIMEOUT_EXCEEDED)"])

    with pytest.raises(RuntimeError, match="TIMEOUT_EXCEEDED"):
        JournalStore(target).write_migration_state(_state())  # type: ignore[arg-type]
    assert [sql for sql in target.calls if _is_write(sql)] == []


def test_a_database_that_never_reaches_the_probed_replica_stops_the_write() -> None:
    """The journal probe succeeded, so a missing database later is lag, not a
    database to create: the write fails instead of being dropped."""
    target = _Target(probe=[_UNKNOWN_DATABASE])

    with pytest.raises(RuntimeError, match="its database is still missing on the replica"):
        JournalStore(target).write_migration_state(_state())  # type: ignore[arg-type]
    assert target.probes == 21
    assert [sql for sql in target.calls if _is_write(sql)] == []


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(
            "Code: 701. DB::Exception: Requested cluster 'default' not found. "
            "(CLUSTER_DOESNT_EXIST)",
            id="a single node without the cluster",
        ),
        pytest.param(
            "Code: 497. DB::Exception: Not enough privileges. (ACCESS_DENIED)",
            id="a user that cannot query the cluster",
        ),
    ],
)
def test_keeps_the_single_replica_path(error: str) -> None:
    target = _Target(probe=[error])

    JournalStore(target).write_migration_state(_state())  # type: ignore[arg-type]

    assert not any(_is_journal_poll(sql) for sql in target.calls)
    assert len([sql for sql in target.calls if sql.startswith("INSERT INTO")]) == 1


def test_waits_for_every_replica_before_upgrading_an_older_journal() -> None:
    target = _Target(probe=[2], legacy=True)

    JournalStore(target).write_migration_state(_state())  # type: ignore[arg-type]

    polls = [index for index, sql in enumerate(target.calls) if _is_journal_poll(sql)]
    assert polls
    assert polls[0] < _first(target.calls, "ALTER TABLE")


def test_every_journal_insert_and_alter_names_the_database() -> None:
    target = _Target(probe=[2], legacy=True)

    JournalStore(target).write_migration_state(_state())  # type: ignore[arg-type]

    writes = [sql for sql in target.calls if _is_write(sql)]
    assert len(writes) > 1
    for sql in writes:
        assert re.match(r"(INSERT INTO|ALTER TABLE) `app`\._chkit_migrations ", sql), sql
