"""The migrate lock against a live server, with a short lease (#716).

Port of ``packages/cli/src/test/migrate-lock.e2e.test.ts``. On a
multi-replica target the claims land on whichever replica takes each request,
so these runs check that every acknowledged claim is read back. Runs against
the server in ``CLICKHOUSE_URL`` / ``CLICKHOUSE_HOST``; an unreachable server
fails the test.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace

import pytest

from chkit.cli.commands.migrate_errors import MigrateError
from chkit.cli.commands.migrate_lock import (
    LOCK_TIMINGS,
    LockDeps,
    LockTarget,
    MigrateLock,
    acquire_migrate_lock,
)
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.replicas import resolve_replica_fanout
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_prefix,
    quote_ident,
    resolve_live_env,
    wait_for_table_on_every_replica,
)

SHORT = replace(LOCK_TIMINGS, lease_ms=12_000, valid_ms=6_000, heartbeat_ms=1_000, attempts=1)


def _connect() -> ClickHouseClient:
    env = resolve_live_env()
    return ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    )


@dataclass
class Live:
    db: ClickHouseClient
    # Another run's connection: a client takes one request at a time.
    other: ClickHouseClient
    target: LockTarget


@pytest.fixture
def live() -> Iterator[Live]:
    db = _connect()
    other = _connect()
    database = f"{create_prefix('py_lock')}db"
    table = "_chkit_migrations"
    db.execute(f"CREATE DATABASE {quote_ident(database)}")
    try:
        db.execute(
            f"CREATE TABLE {quote_ident(database)}.{table} (name String, "
            "applied_at DateTime64(3, 'UTC'), checksum String, chkit_version String, "
            "migration_completed Bool DEFAULT true, operations Array(Tuple(operation_index "
            "Int32, operation_key String, operation_type String, query_id String, status "
            "LowCardinality(String), started_at DateTime64(3, 'UTC'), finished_at "
            "Nullable(DateTime64(3, 'UTC')), last_error String)) DEFAULT []) "
            "ENGINE = ReplacingMergeTree(applied_at) ORDER BY (name) "
            "SETTINGS index_granularity = 1"
        )
        wait_for_table_on_every_replica(db, database, table)
        yield Live(
            db=db,
            other=other,
            target=LockTarget(
                database=database, journal_table=table, fanout=resolve_replica_fanout(db)
            ),
        )
    finally:
        db.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
        db.close()
        other.close()


def _acquire(client: ClickHouseClient, target: LockTarget, **timings: float) -> MigrateLock:
    return acquire_migrate_lock(
        client,
        target,
        break_lock=False,
        log=lambda _line: None,
        deps=LockDeps(timings=replace(SHORT, **timings)),  # type: ignore[arg-type]
    )


def _try_acquire(client: ClickHouseClient, target: LockTarget) -> MigrateLock | MigrateError:
    try:
        return _acquire(client, target)
    except MigrateError as error:
        return error


def _refused(client: ClickHouseClient, target: LockTarget) -> MigrateError:
    result = _try_acquire(client, target)
    assert isinstance(result, MigrateError), "the lock was taken twice"
    return result


def test_a_held_lock_stops_another_run_until_it_is_released(live: Live) -> None:
    held = _acquire(live.db, live.target)
    refused = _refused(live.other, live.target)
    assert refused.code == "migrate_locked"
    assert f"pid {os.getpid()}" in refused.message
    # Heartbeats keep it held past the lease.
    time.sleep((SHORT.lease_ms + 1_000) / 1000)
    held.assert_held()
    assert _refused(live.other, live.target).code == "migrate_locked"
    held.release()
    _acquire(live.db, live.target).release()


def test_the_claim_of_a_stopped_run_expires_after_the_lease(live: Live) -> None:
    # No heartbeat within the test: the run stopped.
    crashed = _acquire(live.db, live.target, heartbeat_ms=600_000)
    assert _refused(live.other, live.target).code == "migrate_locked"
    time.sleep((SHORT.lease_ms + 500) / 1000)
    with pytest.raises(MigrateError, match="lost the migrate lock"):
        crashed.assert_held()
    _acquire(live.db, live.target).release()


def test_of_runs_that_claim_at_once_at_most_one_takes_the_lock(live: Live) -> None:
    clients = [_connect() for _ in range(4)]
    try:
        with ThreadPoolExecutor(max_workers=len(clients)) as pool:
            for _ in range(10):
                results = list(pool.map(lambda c: _try_acquire(c, live.target), clients))
                holders = [r for r in results if isinstance(r, MigrateLock)]
                assert len(holders) <= 1
                for holder in holders:
                    holder.release()
    finally:
        for client in clients:
            client.close()
