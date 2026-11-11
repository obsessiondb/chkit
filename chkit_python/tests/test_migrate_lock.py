"""The migrate lock (#716), against a fake server that keeps the claim rows.

Port of the TS ``commands/migrate/lock.test.ts``.
"""

from __future__ import annotations

import json
import math
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
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
    MigrateLock,
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
OTHER = f"{LOCK_ROW_PREFIX}other"
OTHER_DESCRIBED = (
    "claim other: pid 4242 on host ci-runner-7 (chkit 0.9.0), started 2026-11-11T08:00:00.000Z"
)
_INSERT = re.compile(
    r"SELECT '((?:[^'\\]|\\.)*)', (now64\(3\)|toDateTime64\('([^']*)'[^)]*\)"
    r"|greatest\(now64\(3\), toDateTime64\('([^']*)'.*?\)\)), '((?:[^'\\]|\\.)*)'"
)
_OWN = re.compile(r"OR name = '((?:[^'\\]|\\.)*)'")


def _unquote(value: str) -> str:
    return re.sub(r"\\(.)", r"\1", value)


def _format_version(ms: float) -> str:
    """A version as ClickHouse's toString(DateTime64(3)) prints it."""
    return datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _parse_version(text: str) -> float:
    parsed = datetime.strptime(text, "%Y-%m-%d %H:%M:%S.%f").replace(tzinfo=UTC)
    return round(parsed.timestamp() * 1000)


@dataclass
class Row:
    name: str
    version: float
    holder: str


@dataclass
class FakeServer:
    rows: list[Row] = field(default_factory=list)
    clock: float = datetime(2026, 11, 11, 8, tzinfo=UTC).timestamp() * 1000
    # Names of the claims a read leaves out, as a lagging replica would.
    hidden: set[str] = field(default_factory=set)
    # Names of the claims whose writes the server drops.
    dropped: set[str] = field(default_factory=set)
    # When set, the next read fails, after calling it.
    fail_next_read: Callable[[], None] | None = None

    def execute(self, sql: str, settings: dict[str, Any] | None = None) -> None:
        match = _INSERT.search(sql)
        assert match is not None, sql
        name = _unquote(match[1])
        if name in self.dropped:
            return
        version = self.clock
        if match[3] is not None:
            version = RELEASED
        if match[4] is not None:
            version = max(self.clock, _parse_version(match[4]) + 1)
        self.rows.append(Row(name=name, version=version, holder=_unquote(match[5])))

    def query(self, sql: str, settings: dict[str, Any] | None = None) -> SimpleNamespace:
        fail, self.fail_next_read = self.fail_next_read, None
        if fail is not None:
            fail()
            raise RuntimeError("read failed")
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
                "version": "2299-12-31 23:59:59.000"
                if row.version == RELEASED
                else _format_version(row.version),
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


def _deps(
    clock: Clock,
    sleeps: list[float],
    on_sleep: Callable[[float], None] = lambda _ms: None,
    **timings: float,
) -> LockDeps:
    ids = iter(range(1, 1000))

    def sleep(ms: float) -> None:
        sleeps.append(ms)
        on_sleep(ms)

    return LockDeps(
        now=lambda: clock.now,
        sleep=sleep,
        random=lambda: 0.5,
        new_id=lambda: f"run-{next(ids)}",
        timings=replace(LockTimings(heartbeat_ms=60_000), **timings),  # type: ignore[arg-type]
    )


def _other_claim(server: FakeServer, age_ms: float) -> None:
    server.rows.append(Row(name=OTHER, version=server.clock - age_ms, holder=OTHER_HOLDER))


def _acquire(
    server: FakeServer,
    deps: LockDeps,
    *,
    break_lock: str | None = None,
    log: Callable[[str], None] | None = None,
) -> MigrateLock:
    return acquire_migrate_lock(
        server, TARGET, break_lock=break_lock, log=log or (lambda _line: None), deps=deps
    )


def _wait_for(condition: Callable[[], bool]) -> None:
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
    _other_claim(server, 5_000)
    sleeps: list[float] = []
    with pytest.raises(MigrateError) as caught:
        _acquire(server, _deps(Clock(), sleeps))
    error = caught.value
    assert error.code == "migrate_locked"
    assert f"{OTHER_DESCRIBED}; last heartbeat 5s ago, free in 115s unless renewed" in error.message
    assert "re-run with --break-lock other." in error.message
    assert len(sleeps) == LOCK_TIMINGS.attempts - 1
    for attempt in range(1, LOCK_TIMINGS.attempts + 1):
        assert server.claims_of(f"{LOCK_ROW_PREFIX}run-{attempt}")[-1].version == RELEASED


def test_a_released_claim_does_not_hold_the_lock() -> None:
    server = FakeServer()
    _other_claim(server, 1_000)
    server.rows.append(Row(name=OTHER, version=RELEASED, holder=OTHER_HOLDER))
    _acquire(server, _deps(Clock(), [])).release()


def test_a_claim_past_the_lease_that_does_not_change_while_watched_is_released() -> None:
    server = FakeServer()
    _other_claim(server, LOCK_TIMINGS.lease_ms)
    lines: list[str] = []
    sleeps: list[float] = []
    lock = _acquire(server, _deps(Clock(), sleeps), log=lines.append)
    assert sleeps == [LOCK_TIMINGS.valid_ms + LOCK_TIMINGS.observe_margin_ms]
    assert lines == [
        f"The migrate lock is held by {OTHER_DESCRIBED}, with no heartbeat for 120s; "
        "checking for 65s that it stopped.",
        f"Released the migrate lock of {OTHER_DESCRIBED}, which stopped without releasing it.",
    ]
    assert server.claims_of(OTHER)[-1].version == RELEASED
    lock.assert_held()
    lock.release()


def test_a_claim_past_the_lease_whose_version_moves_while_watched_still_holds_the_lock() -> None:
    server = FakeServer()
    _other_claim(server, LOCK_TIMINGS.lease_ms + 10_000)

    # The holder renews while this run watches, on a replica whose clock is behind.
    def renew(_ms: float) -> None:
        server.rows.append(
            Row(
                name=OTHER,
                version=server.clock - LOCK_TIMINGS.lease_ms - 1_000,
                holder=OTHER_HOLDER,
            )
        )

    with pytest.raises(MigrateError) as caught:
        _acquire(server, _deps(Clock(), [], renew))
    assert caught.value.code == "migrate_locked"
    assert OTHER_DESCRIBED in caught.value.message
    assert server.claims_of(OTHER)[-1].version != RELEASED


def test_break_lock_releases_the_claim_it_names_and_takes_the_lock() -> None:
    server = FakeServer()
    _other_claim(server, 1_000)
    lines: list[str] = []
    lock = _acquire(server, _deps(Clock(), []), break_lock="other", log=lines.append)
    assert lines == [f"Broke the migrate lock of {OTHER_DESCRIBED}."]
    assert server.claims_of(OTHER)[-1].version == RELEASED
    lock.release()


def test_break_lock_naming_another_claim_leaves_the_holder_alone() -> None:
    server = FakeServer()
    _other_claim(server, 1_000)
    lines: list[str] = []
    with pytest.raises(MigrateError) as caught:
        _acquire(server, _deps(Clock(), []), break_lock="stale-one", log=lines.append)
    assert lines == [
        "--break-lock: claim stale-one does not hold the migrate lock; taking the lock as usual."
    ]
    assert caught.value.code == "migrate_locked"
    assert server.claims_of(OTHER)[-1].version != RELEASED


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


def test_a_heartbeat_renews_the_claim_with_a_newer_version_and_keeps_the_lock_held() -> None:
    server = FakeServer()
    clock = Clock()
    lock = _acquire(server, _deps(clock, [], heartbeat_ms=1))
    clock.now = 50_000
    _wait_for(lambda: lock._confirmed_at == 50_000)
    versions = [row.version for row in server.claims_of(f"{LOCK_ROW_PREFIX}run-1")]
    # The server clock stands still: each heartbeat still writes a newer version.
    assert versions[1] == versions[0] + 1
    clock.now = 50_000 + LOCK_TIMINGS.valid_ms
    lock.assert_held()
    lock.release()


def test_a_heartbeat_whose_version_does_not_read_back_newer_does_not_renew_the_claim() -> None:
    server = FakeServer()
    clock = Clock()
    lock = _acquire(server, _deps(clock, [], heartbeat_ms=1))
    server.dropped.add(f"{LOCK_ROW_PREFIX}run-1")
    clock.now = 50_000
    time.sleep(0.03)
    clock.now = LOCK_TIMINGS.valid_ms + 1
    with pytest.raises(MigrateError, match="lost the migrate lock"):
        lock.assert_held()
    server.dropped.clear()
    lock.release()


def test_a_newer_version_read_back_counts_from_the_first_heartbeat_that_may_have_written_it() -> (
    None
):
    server = FakeServer()
    name = f"{LOCK_ROW_PREFIX}run-1"
    clock = Clock()
    lock = _acquire(server, _deps(clock, [], heartbeat_ms=1))
    # The heartbeat sent at 10 s writes a newer version, but its read fails.
    # The next one, sent at 20 s, reaches a replica that drops its write and
    # reads the version the first one wrote.
    failed = [False]

    def fail() -> None:
        failed[0] = True
        server.dropped.add(name)
        clock.now = 20_000

    server.fail_next_read = fail
    clock.now = 10_000
    _wait_for(lambda: failed[0] and len(server.claims_of(name)) == 2)
    time.sleep(0.03)
    clock.now = 10_000 + LOCK_TIMINGS.valid_ms
    lock.assert_held()
    clock.now = 10_000 + LOCK_TIMINGS.valid_ms + 1
    with pytest.raises(MigrateError, match="lost the migrate lock"):
        lock.assert_held()
    server.dropped.clear()
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
    name = f"{LOCK_ROW_PREFIX}x"
    assert claim_insert_sql(TARGET, name, '{"pid":1}', released=False) == (
        columns + f"SELECT '__chkit_migrate_lock__/x', now64(3), '{{\"pid\":1}}', "
        f"'{__version__}', false, []"
    )
    assert claim_insert_sql(
        TARGET, name, '{"pid":1}', released=False, after="2026-11-11 08:00:00.000"
    ) == (
        columns + "SELECT '__chkit_migrate_lock__/x', greatest(now64(3), "
        "toDateTime64('2026-11-11 08:00:00.000', 3, 'UTC') + toIntervalMillisecond(1)), "
        f"'{{\"pid\":1}}', '{__version__}', false, []"
    )
    assert claim_insert_sql(TARGET, name, "it's", released=True) == (
        columns + "SELECT '__chkit_migrate_lock__/x', "
        "toDateTime64('2299-12-31 23:59:59.000', 3, 'UTC'), 'it\\'s', "
        f"'{__version__}', false, []"
    )


def test_the_read_keeps_the_newest_version_of_each_claim_on_every_replica() -> None:
    target = replace(TARGET, fanout=ReplicaFanout(cluster="default", replicas=2))
    assert claims_select_sql(target, f"{LOCK_ROW_PREFIX}x") == (
        "SELECT name, latest.2 AS holder, "
        "latest.1 >= toDateTime64('2299-01-01 00:00:00', 3, 'UTC') AS released, "
        "toString(latest.1) AS version, "
        "toString(toUnixTimestamp64Milli(now64(3)) - toUnixTimestamp64Milli(latest.1)) AS age_ms "
        "FROM (SELECT name, argMax(tuple(applied_at, checksum), applied_at) AS latest "
        "FROM clusterAllReplicas('default', 'app', '_chkit_migrations') "
        "WHERE startsWith(name, '__chkit_migrate_lock__/') GROUP BY name) "
        "WHERE NOT released OR name = '__chkit_migrate_lock__/x' ORDER BY name "
        "SETTINGS skip_unavailable_shards = 0"
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
