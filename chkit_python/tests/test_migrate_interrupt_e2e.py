"""migrate on SIGINT.

Port of the first case of ``packages/cli/src/test/migrate-interrupt.e2e.test.ts``:
a SIGINT while an async load runs stops polling and releases the migrate lock,
the attempt stays recorded as one that may have been sent, and a re-run
records the load once. The CLI runs in a subprocess, sent a real SIGINT.
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
