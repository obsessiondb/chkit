"""migrate on SIGINT (#816).

Port of the CLI cases of ``packages/cli/src/test/migrate-interrupt.e2e.test.ts``:
a SIGINT while an async load runs stops polling and releases the migrate lock,
the attempt stays recorded as one that may have been sent, and a re-run
records the load once; a SIGINT during a sync statement lets it finish and
records it; a second SIGINT exits at once and keeps the lock claim. The CLI
runs in a subprocess, sent a real SIGINT.
"""

from __future__ import annotations

import signal
import time

from chkit.cli.commands.migrate_async_apply import ATTEMPT_RECORD_MARKER
from tests.e2e_testkit import poll_until, quote_ident
from tests.test_migrate_async_rerun_e2e import (
    _ROWS,
    Fixture,
    _diagnostic,
    _journal,
    _start,
    _wait,
    make_fixture,  # noqa: F401 - the pytest fixture
)

_RELEASED = (
    "migrate: interrupted (SIGINT). No new statement was started. The migrate lock is released."
)
_ASYNC_LOAD = (
    "-- operation: load_table_data key=table:events risk=caution mode=async\n"
    f"INSERT INTO events SELECT number FROM numbers({_ROWS}) "
    "WHERE sleepEachRow(0.25) = 0 SETTINGS max_block_size = 1;\n"
)
# About 3 s.
_SYNC_LOAD = (
    "-- operation: load_table_data key=table:events risk=caution\n"
    "INSERT INTO events SELECT number + 1000 FROM numbers(12) "
    "WHERE sleepEachRow(0.25) = 0 SETTINGS max_block_size = 1;\n"
)


def _write_migration(fixture: Fixture, sql: str) -> None:
    (fixture.dir / "chkit/migrations" / fixture.migration).write_text(sql, encoding="utf-8")


def _wait_for_sync_load(fixture: Fixture) -> None:
    """Waits until the server runs the sync load, so a SIGINT comes after it was sent."""
    query = (
        "SELECT toString(count()) AS n FROM system.processes "
        "WHERE query LIKE '%number + 1000%' "
        f"AND current_database = '{fixture.database}' AND query NOT LIKE '%system.processes%'"
    )
    running = poll_until(
        lambda: str(fixture.client.query(query).rows[0]["n"]),
        lambda n: n == "1",
        timeout=60.0,
        interval=0.05,
    )
    assert running == "1", "the sync load never ran"


def _statuses(fixture: Fixture) -> list[str]:
    rows = fixture.client.query(
        "SELECT arrayMap(o -> o.status, operations) AS s "
        f"FROM {quote_ident(fixture.database)}.{quote_ident(fixture.journal_table)} "
        f"FINAL WHERE name = '{fixture.migration}' SETTINGS select_sequential_consistency = 1"
    ).rows
    return [str(value) for value in rows[0]["s"]] if rows else []


def _held_claims(fixture: Fixture) -> list[str]:
    prefix = "__chkit_migrate_lock__/"
    rows = fixture.client.query(
        f"SELECT name FROM {quote_ident(fixture.database)}.{quote_ident(fixture.journal_table)} "
        f"WHERE startsWith(name, '{prefix}') GROUP BY name "
        "HAVING max(applied_at) < toDateTime64('2299-01-01 00:00:00', 3, 'UTC') "
        "SETTINGS select_sequential_consistency = 1"
    ).rows
    return [str(row["name"]) for row in rows]


def _marker(fixture: Fixture) -> str:
    rows = fixture.client.query(
        "SELECT operations[1].last_error AS marker "
        f"FROM {quote_ident(fixture.database)}.{quote_ident(fixture.journal_table)} "
        f"FINAL WHERE name = '{fixture.migration}' SETTINGS select_sequential_consistency = 1"
    ).rows
    return str(rows[0]["marker"]) if rows else ""


def test_a_sigint_while_an_async_load_runs_releases_the_lock_and_keeps_the_attempt(
    make_fixture: Fixture,  # noqa: F811 - the pytest fixture
) -> None:
    fixture = make_fixture
    run = _start(fixture)
    started = poll_until(
        lambda: (_journal(fixture), _marker(fixture)),
        lambda value: value[1] == ATTEMPT_RECORD_MARKER,
        timeout=60.0,
        interval=0.1,
    )
    assert started[1] == ATTEMPT_RECORD_MARKER, started
    query_id = started[0][1]
    running = poll_until(
        lambda: fixture.client.query_status(query_id, every_replica=True, running_only=True),
        lambda found: found.status == "running",
        timeout=10.0,
        interval=0.1,
    )
    assert running.status == "running"
    sent_at = time.monotonic()
    run.send_signal(signal.SIGINT)
    result = _wait(run)

    assert result.exit_code == 130, _diagnostic("interrupted run", result)
    # It does not wait for the load (about 4 s) or for its next poll (5 s).
    assert time.monotonic() - sent_at < 3.0
    assert _RELEASED in result.stderr
    assert _held_claims(fixture) == []
    assert _journal(fixture) == ("started", query_id)
    assert _marker(fixture) == ATTEMPT_RECORD_MARKER

    # No --break-lock: the lock is free, and the load is recorded once.
    rerun = _wait(_start(fixture))
    assert rerun.exit_code == 0, _diagnostic("re-run", rerun)
    assert "resubmitting" not in rerun.stderr
    assert _journal(fixture)[0] == "completed"
    count = fixture.client.query(
        f"SELECT count() AS n FROM {quote_ident(fixture.database)}.events"
    ).rows[0]["n"]
    assert int(count) == _ROWS


def test_a_sigint_during_a_sync_statement_lets_it_finish_and_releases_the_lock(
    make_fixture: Fixture,  # noqa: F811 - the pytest fixture
) -> None:
    fixture = make_fixture
    _write_migration(fixture, _SYNC_LOAD + _ASYNC_LOAD)
    run = _start(fixture)
    _wait_for_sync_load(fixture)
    run.send_signal(signal.SIGINT)
    result = _wait(run)

    assert result.exit_code == 130, _diagnostic("interrupted run", result)
    assert _RELEASED in result.stderr
    assert _held_claims(fixture) == []
    # The sync statement completed; the async one was never attempted.
    assert _statuses(fixture) == ["completed"]
    count = fixture.client.query(
        f"SELECT count() AS n FROM {quote_ident(fixture.database)}.events"
    ).rows[0]["n"]
    assert int(count) == 12


def test_a_second_sigint_exits_at_once_and_keeps_the_lock_claim(
    make_fixture: Fixture,  # noqa: F811 - the pytest fixture
) -> None:
    fixture = make_fixture
    _write_migration(fixture, _SYNC_LOAD)
    run = _start(fixture)
    _wait_for_sync_load(fixture)
    run.send_signal(signal.SIGINT)
    time.sleep(0.2)
    sent_at = time.monotonic()
    run.send_signal(signal.SIGINT)
    result = _wait(run)

    assert result.exit_code == 130, _diagnostic("interrupted run", result)
    assert time.monotonic() - sent_at < 1.5
    claims = _held_claims(fixture)
    assert len(claims) == 1
    claim = claims[0].removeprefix("__chkit_migrate_lock__/")
    assert (
        f"migrate: SIGINT again, exiting at once. The migrate lock claim {claim} stays in place"
        in result.stderr
    )
    assert "The migrate lock is released" not in result.stderr
