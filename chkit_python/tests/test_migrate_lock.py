"""The migrate lock (#716), against a fake server that keeps the claim rows.

Port of the TS ``commands/migrate/lock.test.ts``.
"""

from __future__ import annotations

import json
import math
import re
import time
from dataclasses import dataclass, field, replace
from types import SimpleNamespace
from typing import Any

import pytest

from chkit import __version__
from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.commands.migrate_lock import (
    LOCK_ROW_PREFIX,
    LOCK_TIMINGS,
    GuardedClient,
    LockDeps,
    LockTarget,
    LockTimings,
    acquire_migrate_lock,
    claim_insert_sql,
    claims_select_sql,
)
from chkit.clickhouse.replicas import ReplicaFanout

TARGET = LockTarget(database="app", journal_table="_chkit_migrations", fanout=None)
RELEASED = math.inf
OTHER_HOLDER = json.dumps(
    {
        "host": "ci-runner-7",
        "pid": 4242,
        "chkitVersion": "0.9.0",
        "startedAt": "2026-11-11T08:00:00.000Z",
    }
)
_INSERT = re.compile(
    r"SELECT '((?:[^'\\]|\\.)*)', (now64\(3\)|toDateTime64\([^)]*\)), '((?:[^'\\]|\\.)*)'"
)
_OWN = re.compile(r"OR name = '((?:[^'\\]|\\.)*)'")


def _unquote(value: str) -> str:
    return re.sub(r"\\(.)", r"\1", value)


@dataclass
class Row:
    name: str
    version: float
    holder: str


@dataclass
class FakeServer:
    rows: list[Row] = field(default_factory=list)
    clock: float = 1_000_000
    # Names of the claims a read leaves out, as a lagging replica would.
    hidden: set[str] = field(default_factory=set)

    def execute(self, sql: str, settings: dict[str, Any] | None = None) -> None:
        match = _INSERT.search(sql)
        assert match is not None, sql
        self.rows.append(
            Row(
                name=_unquote(match[1]),
                version=self.clock if match[2] == "now64(3)" else RELEASED,
                holder=_unquote(match[3]),
            )
        )

    def query(self, sql: str, settings: dict[str, Any] | None = None) -> SimpleNamespace:
        found = _OWN.search(sql)
        own = _unquote(found[1]) if found else ""
        latest: dict[str, Row] = {}
        for row in self.rows:
            if row.name in self.hidden:
                continue
            seen = latest.get(row.name)
            if seen is None or row.version >= seen.version:
                latest[row.name] = row
        rows = [
            {
                "name": row.name,
                "holder": row.holder,
                "released": 1 if row.version == RELEASED else 0,
                "age_ms": "-1" if row.version == RELEASED else str(int(self.clock - row.version)),
            }
            for row in latest.values()
            if row.version != RELEASED or row.name == own
        ]
        return SimpleNamespace(rows=rows)

    def claims_of(self, name: str) -> list[Row]:
        return [row for row in self.rows if row.name == name]


@dataclass
class Clock:
    now: float = 0


def _deps(clock: Clock, sleeps: list[float], **timings: float) -> LockDeps:
    ids = iter(range(1, 1000))

    return LockDeps(
        now=lambda: clock.now,
        sleep=sleeps.append,
        random=lambda: 0.5,
        new_id=lambda: f"run-{next(ids)}",
        timings=replace(LockTimings(heartbeat_ms=60_000), **timings),  # type: ignore[arg-type]
    )


def _live_claim(server: FakeServer, age_ms: float, name: str = f"{LOCK_ROW_PREFIX}other") -> None:
    server.rows.append(Row(name=name, version=server.clock - age_ms, holder=OTHER_HOLDER))


def _acquire(server: FakeServer, deps: LockDeps, *, break_lock: bool = False, log: Any = None):  # type: ignore[no-untyped-def]
    return acquire_migrate_lock(
        server, TARGET, break_lock=break_lock, log=log or (lambda _line: None), deps=deps
    )


def _wait_for(condition: Any) -> None:
    for _ in range(200):
        if condition():
            return
        time.sleep(0.005)
    assert condition()


def test_takes_a_free_lock_and_releases_it() -> None:
    server = FakeServer()
    lock = _acquire(server, _deps(Clock(), []))
    name = f"{LOCK_ROW_PREFIX}run-1"
    assert [row.version for row in server.claims_of(name)] == [server.clock]
    lock.assert_held()
    lock.release()
    assert server.claims_of(name)[-1].version == RELEASED


def test_a_live_claim_stops_it_after_every_attempt_naming_the_holder() -> None:
    server = FakeServer()
    _live_claim(server, 5_000)
    sleeps: list[float] = []
    with pytest.raises(MigrateError) as caught:
        _acquire(server, _deps(Clock(), sleeps))
    error = caught.value
    assert error.code == "migrate_locked"
    assert (
        "pid 4242 on host ci-runner-7 (chkit 0.9.0), started 2026-11-11T08:00:00.000Z"
        in error.message
    )
    assert "last heartbeat 5s ago, expires in 115s unless renewed" in error.message
    assert "--break-lock" in error.message
    assert len(sleeps) == LOCK_TIMINGS.attempts - 1
    for attempt in range(1, LOCK_TIMINGS.attempts + 1):
        assert server.claims_of(f"{LOCK_ROW_PREFIX}run-{attempt}")[-1].version == RELEASED


def test_a_claim_older_than_the_lease_has_expired() -> None:
    server = FakeServer()
    _live_claim(server, LOCK_TIMINGS.lease_ms)
    lock = _acquire(server, _deps(Clock(), []))
    lock.assert_held()
    lock.release()


def test_a_released_claim_does_not_hold_the_lock() -> None:
    server = FakeServer()
    _live_claim(server, 1_000)
    server.rows.append(Row(name=f"{LOCK_ROW_PREFIX}other", version=RELEASED, holder=OTHER_HOLDER))
    _acquire(server, _deps(Clock(), [])).release()


def test_break_lock_releases_the_live_claims_says_whose_and_takes_the_lock() -> None:
    server = FakeServer()
    _live_claim(server, 1_000)
    lines: list[str] = []
    lock = _acquire(server, _deps(Clock(), []), break_lock=True, log=lines.append)
    assert lines == [
        "Broke the migrate lock held by pid 4242 on host ci-runner-7 (chkit 0.9.0), "
        "started 2026-11-11T08:00:00.000Z."
    ]
    assert server.claims_of(f"{LOCK_ROW_PREFIX}other")[-1].version == RELEASED
    lock.release()


def test_a_run_that_cannot_read_its_own_claim_back_stops() -> None:
    server = FakeServer()
    server.hidden.add(f"{LOCK_ROW_PREFIX}run-1")
    with pytest.raises(MigrateError) as caught:
        _acquire(server, _deps(Clock(), []))
    assert caught.value.code == "migrate_lock_unverifiable"
    assert "CHKIT_MIGRATE_LOCK=off" in caught.value.message


def test_stops_once_no_heartbeat_was_acknowledged_for_valid_ms() -> None:
    server = FakeServer()
    clock = Clock()
    lock = _acquire(server, _deps(clock, []))
    clock.now = LOCK_TIMINGS.valid_ms
    lock.assert_held()
    clock.now = LOCK_TIMINGS.valid_ms + 1
    with pytest.raises(MigrateError, match="lost the migrate lock"):
        lock.assert_held()
    lock.release()


def test_a_heartbeat_renews_the_claim_and_keeps_the_lock_held() -> None:
    server = FakeServer()
    clock = Clock()
    lock = _acquire(server, _deps(clock, [], heartbeat_ms=1))
    clock.now = 50_000
    server.clock += 50_000
    _wait_for(lambda: len(server.claims_of(f"{LOCK_ROW_PREFIX}run-1")) >= 2)
    _wait_for(lambda: lock._confirmed_at == 50_000)
    clock.now = 50_000 + LOCK_TIMINGS.valid_ms
    lock.assert_held()
    lock.release()


def test_a_heartbeat_sent_after_the_claim_lapsed_does_not_renew_it() -> None:
    server = FakeServer()
    clock = Clock()
    lock = _acquire(server, _deps(clock, [], heartbeat_ms=20))
    # The process was paused past the validity: another run may hold the lock now.
    clock.now = LOCK_TIMINGS.valid_ms + 1
    time.sleep(0.06)
    assert len(server.claims_of(f"{LOCK_ROW_PREFIX}run-1")) == 1
    with pytest.raises(MigrateError, match="no heartbeat was acknowledged for 60s"):
        lock.assert_held()
    lock.release()


def test_a_claim_another_run_released_is_lost_at_the_next_heartbeat() -> None:
    server = FakeServer()
    lock = _acquire(server, _deps(Clock(), [], heartbeat_ms=1))
    server.rows.append(Row(name=f"{LOCK_ROW_PREFIX}run-1", version=RELEASED, holder=OTHER_HOLDER))

    def lost() -> bool:
        try:
            lock.assert_held()
        except MigrateError:
            return True
        return False

    _wait_for(lost)
    with pytest.raises(MigrateError, match=r"another run released it \(--break-lock\)"):
        lock.assert_held()
    lock.release()


# The TS port writes and reads the same rows, so a TS and a chkit-py run exclude each other.
def test_claims_are_journal_rows_the_migration_reads_skip() -> None:
    columns = (
        "INSERT INTO `app`._chkit_migrations "
        "(name, applied_at, checksum, chkit_version, migration_completed, operations) "
    )
    assert claim_insert_sql(TARGET, f"{LOCK_ROW_PREFIX}x", '{"pid":1}', released=False) == (
        columns + f"SELECT '__chkit_migrate_lock__/x', now64(3), '{{\"pid\":1}}', "
        f"'{__version__}', false, []"
    )
    assert claim_insert_sql(TARGET, f"{LOCK_ROW_PREFIX}x", "it's", released=True) == (
        columns + "SELECT '__chkit_migrate_lock__/x', "
        "toDateTime64('2299-12-31 23:59:59.000', 3, 'UTC'), 'it\\'s', "
        f"'{__version__}', false, []"
    )


def test_the_read_keeps_the_newest_version_of_each_claim_on_every_replica() -> None:
    target = replace(TARGET, fanout=ReplicaFanout(cluster="default", replicas=2))
    assert claims_select_sql(target, f"{LOCK_ROW_PREFIX}x") == (
        "SELECT name, latest.2 AS holder, "
        "latest.1 >= toDateTime64('2299-01-01 00:00:00', 3, 'UTC') AS released, "
        "toString(toUnixTimestamp64Milli(now64(3)) - toUnixTimestamp64Milli(latest.1)) AS age_ms "
        "FROM (SELECT name, argMax(tuple(applied_at, checksum), applied_at) AS latest "
        "FROM clusterAllReplicas('default', 'app', '_chkit_migrations') "
        "WHERE startsWith(name, '__chkit_migrate_lock__/') GROUP BY name) "
        "WHERE NOT released OR name = '__chkit_migrate_lock__/x' ORDER BY name"
    )


def test_guarded_client_checks_before_every_request_but_close() -> None:
    calls: list[str] = []
    held = [True]

    class Client:
        def query(self, sql: str) -> list[Any]:
            calls.append("query")
            return []

        def close(self) -> None:
            calls.append("close")

    def check() -> None:
        calls.append("check")
        if not held[0]:
            raise RuntimeError("lost")

    guarded: Any = GuardedClient(Client(), check)
    guarded.query("SELECT 1")
    held[0] = False
    with pytest.raises(RuntimeError, match="lost"):
        guarded.query("SELECT 1")
    guarded.close()
    assert calls == ["check", "query", "check", "close"]
