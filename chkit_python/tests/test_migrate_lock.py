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
from unittest.mock import MagicMock

import pytest
from clickhouse_connect.driver.exceptions import DatabaseError  # type: ignore[import-untyped]

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
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.replicas import ReplicaFanout
from chkit.core.model import ChxResolvedClickHouseConfig

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


def _beat_of(row: Row) -> int:
    return int(json.loads(row.holder).get("beat", 0))


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
    # Decides each heartbeat write by its beat: "hold" fails the request but
    # keeps the row in ``held``, for the test to commit later.
    on_beat: Callable[[int], str] | None = None
    held: list[Row] = field(default_factory=list)

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
        row = Row(name=name, version=version, holder=_unquote(match[5]))
        beat = json.loads(row.holder).get("beat", -1)
        decision = "write"
        if version != RELEASED and beat >= 1 and self.on_beat is not None:
            decision = self.on_beat(beat)
        if decision == "drop":
            return
        if decision == "hold":
            self.held.append(row)
            raise RuntimeError("connection lost")
        self.rows.append(row)

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
            # argMax by (version, beat), as the claim read does.
            if seen is None or (row.version, _beat_of(row)) >= (seen.version, _beat_of(seen)):
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


def test_a_claim_past_the_lease_whose_heartbeat_writes_the_same_version_still_holds() -> None:
    server = FakeServer()
    version = server.clock - LOCK_TIMINGS.lease_ms - 10_000

    def beat(n: int) -> str:
        return json.dumps({**json.loads(OTHER_HOLDER), "beat": n})

    server.rows.append(Row(name=OTHER, version=version, holder=beat(1)))

    # The next heartbeat lands on a replica whose clock gives it the same version.
    def renew(_ms: float) -> None:
        server.rows.append(Row(name=OTHER, version=version, holder=beat(2)))

    with pytest.raises(MigrateError) as caught:
        _acquire(server, _deps(Clock(), [], renew))
    assert caught.value.code == "migrate_locked"
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


def _is_lost(lock: MigrateLock) -> bool:
    try:
        lock.assert_held()
    except MigrateError:
        return True
    return False


def test_a_heartbeat_whose_row_does_not_read_back_stops_the_run() -> None:
    server = FakeServer()
    name = f"{LOCK_ROW_PREFIX}run-1"
    lock = _acquire(server, _deps(Clock(), [], heartbeat_ms=1))
    server.dropped.add(name)
    _wait_for(lambda: _is_lost(lock))
    with pytest.raises(MigrateError, match="its heartbeat did not read back"):
        lock.assert_held()
    server.dropped.clear()
    lock.release()


def test_a_failed_read_of_a_heartbeat_is_tried_again_and_counts_from_its_send_time() -> None:
    server = FakeServer()
    name = f"{LOCK_ROW_PREFIX}run-1"
    clock = Clock()
    sleeps: list[float] = []
    lock = _acquire(server, _deps(clock, sleeps, heartbeat_ms=1))
    failed = [False]

    def fail() -> None:
        failed[0] = True
        clock.now = 20_000

    server.fail_next_read = fail
    clock.now = 10_000
    _wait_for(lambda: failed[0] and len(server.claims_of(name)) >= 3)
    assert 1_000 in sleeps
    clock.now = 20_000 + LOCK_TIMINGS.valid_ms
    lock.assert_held()
    lock.release()


def test_a_heartbeat_whose_request_fails_and_does_not_read_back_stops_the_run() -> None:
    server = FakeServer()
    name = f"{LOCK_ROW_PREFIX}run-1"
    # Beat 1 loses its connection; the server may still commit it later.
    server.on_beat = lambda beat: "hold" if beat == 1 else "write"
    lock = _acquire(server, _deps(Clock(), [], heartbeat_ms=1))
    _wait_for(lambda: _is_lost(lock))
    with pytest.raises(
        MigrateError,
        match=r"a heartbeat failed \(connection lost\) and may still reach the server",
    ):
        lock.assert_held()
    assert len(server.held) == 1
    # No heartbeat after it.
    assert len(server.claims_of(name)) == 1
    server.on_beat = None
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
        "FROM (SELECT name, argMax(tuple(applied_at, checksum), "
        "tuple(applied_at, JSONExtractInt(checksum, 'beat'))) AS latest "
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


@pytest.mark.parametrize("lose_lock", [False, True])
def test_missing_database_retry_checks_lock_ownership_again(lose_lock: bool) -> None:
    held = True
    driver = MagicMock()

    def first_request(*_args: Any, **_kwargs: Any) -> None:
        nonlocal held
        if driver.command.call_count == 1:
            held = not lose_lock
            raise DatabaseError("Code: 81. UNKNOWN_DATABASE")

    driver.command.side_effect = first_request
    raw = ClickHouseClient(
        driver,
        ChxResolvedClickHouseConfig(
            url="http://localhost:8123", username="default", password="", database="app", secure=False
        ),
    )

    def check() -> None:
        if not held:
            raise MigrateError("migrate_lock_lost", "lost before retry")

    client = GuardedClient(raw, check)
    settings = {"max_threads": 1}
    if lose_lock:
        with pytest.raises(MigrateError, match="lost before retry"):
            client.execute("INSERT INTO app.events SELECT 1", settings)
    else:
        client.execute("INSERT INTO app.events SELECT 1", settings)
    assert driver.command.call_count == (1 if lose_lock else 2)
    if not lose_lock:
        assert driver.command.call_args.kwargs == {"settings": settings, "use_database": False}
