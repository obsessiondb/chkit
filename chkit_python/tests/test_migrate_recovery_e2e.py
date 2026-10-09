"""Live coverage for recovering a migration that failed part-way (#233).

Port of ``packages/cli/src/test/migrate-recovery.e2e.test.ts``: ``--retry``
with an edited file, ``--abandon`` (preview and perform), the automatic
restart of an edited file once nothing has completed, and the refusal of
pending files without executable statements.

Runs the CLI in-process through ``typer.testing.CliRunner`` against the
server in ``CLICKHOUSE_URL`` / ``CLICKHOUSE_HOST``; an unreachable server
fails the test.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.commands.migrate_errors import EMPTY_MIGRATIONS_SUMMARY
from chkit.cli.journal_store import JournalStore
from chkit.cli.main import app
from chkit.cli.migration_store import checksum_sql
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_column, wait_for_table, wait_for_view
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    get_required_env,
    quote_ident,
    wait_for_table_on_every_replica,
)

_POLL_TIMEOUT_SECONDS = 90.0
_POLL_INTERVAL_SECONDS = 1.0


@dataclass
class Project:
    dir: Path
    migrations_dir: Path
    meta_dir: Path
    database: str
    journal_table: str
    prefix: str
    client: ClickHouseClient


@dataclass(frozen=True)
class JournalRow:
    checksum: str
    completed: int
    statuses: str


def _config_source(env: Any, dir_: Path) -> str:
    return f"""
from chkit import define_config

config = define_config(
    {{
        "schema": "{dir_}/schema.py",
        "outDir": "{dir_}/chkit",
        "migrationsDir": "{dir_}/chkit/migrations",
        "metaDir": "{dir_}/chkit/meta",
        "clickhouse": {{
            "url": "{env.clickhouse_url}",
            "username": "{env.clickhouse_user}",
            "password": "{env.clickhouse_password}",
            "database": "{env.clickhouse_database}",
        }},
    }}
)
"""


@pytest.fixture
def make_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Callable[[str], Project]]:
    env = get_required_env()
    created: list[tuple[Project, list[str], list[str]]] = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CI", "1")

    def make(label: str) -> Project:
        journal_table = create_journal_table_name(label)
        monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
        (tmp_path / "chkit/migrations").mkdir(parents=True, exist_ok=True)
        (tmp_path / "clickhouse.config.py").write_text(
            _config_source(env, tmp_path), encoding="utf-8"
        )
        client = ClickHouseClient.connect(
            ChxResolvedClickHouseConfig(
                url=env.clickhouse_url,
                username=env.clickhouse_user,
                password=env.clickhouse_password,
                database=env.clickhouse_database,
                secure=env.clickhouse_url.startswith("https:"),
            )
        )
        project = Project(
            dir=tmp_path,
            migrations_dir=tmp_path / "chkit/migrations",
            meta_dir=tmp_path / "chkit/meta",
            database=env.clickhouse_database,
            journal_table=journal_table,
            prefix=create_prefix(f"py_{label}"),
            client=client,
        )
        # chkit creates the journal and reads it right away; on a multi-replica
        # service the read can land on a replica that has not applied that
        # CREATE yet. Create it up front and wait until every replica lists it.
        JournalStore(client)._ensure_table()
        wait_for_table_on_every_replica(client, project.database, journal_table)
        created.append((project, [], []))
        return project

    yield make

    for project, _views, _tables in created:
        project.client.close()


def _drop(project: Project, *, views: list[str], tables: list[str]) -> None:
    db = quote_ident(project.database)
    for view in views:
        project.client.execute(f"DROP VIEW IF EXISTS {db}.{quote_ident(view)}")
    for table in [*tables, project.journal_table]:
        project.client.execute(f"DROP TABLE IF EXISTS {db}.{quote_ident(table)}")


def _migrate(args: list[str]) -> Any:
    return CliRunner().invoke(app, ["migrate", *args])


def _parse(result: Any) -> dict[str, Any]:
    assert result.exit_code == 0, format_test_diagnostic("expected a successful --json run", result)
    payload: dict[str, Any] = json.loads(result.stdout)
    return payload


def _error_of(result: Any) -> dict[str, Any]:
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is False, result.stdout
    error: dict[str, Any] = envelope["error"]
    return error


def _write(project: Project, name: str, sql: str) -> None:
    (project.migrations_dir / name).write_text(sql, encoding="utf-8")


def _create_table(project: Project, table: str) -> None:
    project.client.execute(
        f"CREATE TABLE {quote_ident(project.database)}.{quote_ident(table)} "
        "(id UInt64) ENGINE = MergeTree ORDER BY id"
    )
    # The test writes to the table next; every replica must have it.
    wait_for_table_on_every_replica(project.client, project.database, table)


def _wait_rows(
    project: Project,
    sql: str,
    predicate: Callable[[list[dict[str, Any]]], bool],
    label: str,
) -> list[dict[str, Any]]:
    """State-based polling: ObsessionDB writes are eventually consistent."""
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    rows: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        rows = project.client.query(sql).rows
        if predicate(rows):
            return rows
        time.sleep(_POLL_INTERVAL_SECONDS)
    msg = f"timed out waiting for {label}; last rows: {rows}"
    raise AssertionError(msg)


def _wait_journal(
    project: Project, migration: str, predicate: Callable[[JournalRow], bool]
) -> JournalRow:
    """The journal is a ReplacingMergeTree read with FINAL; poll for the newest version."""
    sql = (
        "SELECT checksum, toString(toUInt8(migration_completed)) AS completed, "
        "arrayStringConcat(arrayMap(o -> o.status, operations), ',') AS statuses "
        f"FROM {quote_ident(project.database)}.{quote_ident(project.journal_table)} FINAL "
        f"WHERE name = '{migration}' SETTINGS select_sequential_consistency = 1"
    )

    def to_row(rows: list[dict[str, Any]]) -> JournalRow | None:
        if not rows:
            return None
        row = rows[0]
        return JournalRow(
            checksum=str(row["checksum"]),
            completed=int(row["completed"]),
            statuses=str(row["statuses"]),
        )

    def matches(rows: list[dict[str, Any]]) -> bool:
        row = to_row(rows)
        return row is not None and predicate(row)

    found = to_row(_wait_rows(project, sql, matches, f"journal state of {migration}"))
    assert found is not None
    return found


def _count(project: Project, sql: str) -> int:
    return int(project.client.query(sql).rows[0]["n"])


def _three_statement_migration(*, db: str, a: str, v: str, view_source: str, b: str) -> str:
    """Statement 1 is not idempotent; statement 2 fails until ``view_source`` exists."""
    return "\n".join(
        [
            f"-- operation: alter_table_add_column key=table:{db}.{a} risk=safe",
            f"ALTER TABLE {db}.{a} ADD COLUMN c1 UInt64;",
            "",
            f"-- operation: create_view key=view:{db}.{v} risk=safe",
            f"CREATE VIEW {db}.{v} AS SELECT id FROM {db}.{view_source};",
            "",
            f"-- operation: create_table key=table:{db}.{b} risk=safe",
            f"CREATE TABLE {db}.{b} (id UInt64) ENGINE = MergeTree ORDER BY id;",
            "",
        ]
    )


def test_retry_resumes_edited_migration_and_later_failure_resumes_without_retry(  # noqa: PLR0915 - one scenario, as in TS
    make_project: Callable[[str], Project],
) -> None:
    project = make_project("retry")
    db, prefix = project.database, project.prefix
    a, b, c, v = f"{prefix}a", f"{prefix}b", f"{prefix}c", f"{prefix}v"
    m = "20990101000000_recover.sql"
    v1 = _three_statement_migration(db=db, a=a, v=v, view_source=b, b=b)
    v2 = _three_statement_migration(db=db, a=a, v=v, view_source=c, b=b)
    try:
        _create_table(project, a)
        _write(project, m, v1)

        no_state = _parse(_migrate(["--json", "--retry", "20990101000000_recover"]))
        assert no_state["retry"] == {"action": "none", "migration": m, "reason": "not_in_progress"}

        run1 = _migrate(["--execute", "--json"])
        assert run1.exit_code == 1
        assert f"Migration {m} failed at statement 2 of 3" in _error_of(run1)["message"]
        wait_for_column(project.client, db, a, "c1")

        typo = _migrate(["--execute", "--json", "--retry", "nope"])
        assert typo.exit_code == 1
        assert _error_of(typo)["code"] == "migration_not_found"

        _write(project, m, v2)
        refused = _migrate(["--execute", "--json"])
        assert refused.exit_code == 1
        assert _error_of(refused)["code"] == "in_progress_checksum_mismatch"
        assert f"chkit migrate --apply --retry {m}" in _error_of(refused)["message"]
        assert f"chkit migrate --apply --abandon {m}" in _error_of(refused)["message"]

        preview = _parse(_migrate(["--json", "--retry", m]))
        assert preview["mode"] == "plan"
        assert preview["retry"] == {
            "action": "resume",
            "migration": m,
            "previousChecksum": checksum_sql(v1),
            "checksum": checksum_sql(v2),
            "totalStatements": 3,
            "completedStatements": 1,
            "resumeAtStatement": 2,
            "unmarkedCompletedStatements": 0,
        }
        # The preview wrote nothing.
        _wait_journal(project, m, lambda r: r.checksum == checksum_sql(v1) and r.completed == 0)
        # A --table selector that matches nothing still reports what --retry did.
        no_match = _parse(_migrate(["--json", "--retry", m, "--table", f"{db}.nomatch"]))
        assert no_match["pending"] == []
        assert no_match["warning"] == f'No tables matched selector "{db}.nomatch".'
        assert no_match["retry"] == {"action": "none", "migration": m, "reason": "not_in_scope"}

        # Statement 2 still fails (table c is missing), but statement 1 was skipped.
        retry_run = _migrate(["--execute", "--json", "--retry", f"chkit/migrations/{m}"])
        assert retry_run.exit_code == 1
        assert f"Migration {m} failed at statement 2 of 3" in _error_of(retry_run)["message"]
        _wait_journal(project, m, lambda r: r.checksum == checksum_sql(v2) and r.completed == 0)

        _create_table(project, c)
        resumed = _migrate(["--execute", "--json"])
        assert resumed.exit_code == 0, format_test_diagnostic("resume without --retry", resumed)
        applied = _parse(resumed)["applied"]
        assert [(e["name"], e["checksum"]) for e in applied] == [(m, checksum_sql(v2))]
        wait_for_view(project.client, db, v)
        _wait_journal(
            project,
            m,
            lambda r: r.completed == 1
            and r.checksum == checksum_sql(v2)
            and r.statuses == "completed,completed,completed",
        )

        # The same --retry command in an environment where nothing is pending.
        done = _parse(_migrate(["--execute", "--json", "--retry", m]))
        assert (done["mode"], done["pending"], done["applied"]) == ("execute", [], [])
        assert done["retry"] == {"action": "none", "migration": m, "reason": "already_applied"}
        done_text = _migrate(["--retry", m])
        assert done_text.exit_code == 0, format_test_diagnostic("--retry, nothing pending", done_text)
        assert "No pending migrations." in done_text.stdout
        assert f"Retry {m}: already applied; --retry has no effect." in done_text.stdout
    finally:
        _drop(project, views=[v], tables=[a, b, c])


def test_abandon_previews_then_resets_so_edited_file_runs_from_statement_1(  # noqa: PLR0915 - one scenario, as in TS
    make_project: Callable[[str], Project],
) -> None:
    project = make_project("abandon")
    db, prefix = project.database, project.prefix
    a, b, v = f"{prefix}a", f"{prefix}b", f"{prefix}v"
    m = "20990101000000_recover.sql"
    v1 = _three_statement_migration(db=db, a=a, v=v, view_source=b, b=b)
    # Statement 1 moved: --retry must refuse, and the whole file is safe to run twice.
    v3 = "\n".join(
        [
            f"-- operation: create_table key=table:{db}.{b} risk=safe",
            f"CREATE TABLE IF NOT EXISTS {db}.{b} (id UInt64) ENGINE = MergeTree ORDER BY id;",
            "",
            f"-- operation: alter_table_add_column key=table:{db}.{a} risk=safe",
            f"ALTER TABLE {db}.{a} ADD COLUMN IF NOT EXISTS c1 UInt64;",
            "",
            f"-- operation: create_view key=view:{db}.{v} risk=safe",
            f"CREATE VIEW {db}.{v} AS SELECT id FROM {db}.{b};",
            "",
        ]
    )
    try:
        _create_table(project, a)
        _write(project, m, v1)
        run1 = _migrate(["--execute", "--json"])
        assert run1.exit_code == 1
        assert f"Migration {m} failed at statement 2 of 3" in _error_of(run1)["message"]
        wait_for_column(project.client, db, a, "c1")
        _wait_journal(project, m, lambda r: r.statuses == "completed,failed")

        _write(project, m, v3)
        mismatch = _migrate(["--execute", "--json", "--retry", m])
        assert mismatch.exit_code == 1
        assert _error_of(mismatch)["code"] == "retry_mismatch"
        assert "statement 1: completed as alter_table_add_column" in _error_of(mismatch)["message"]
        assert f"chkit migrate --apply --abandon {m}" in _error_of(mismatch)["message"]

        def check_report(report: dict[str, Any]) -> None:
            assert report["migration"] == m
            assert report["checksum"] == checksum_sql(v1)
            assert report["completedStatements"] == 1
            assert [
                (o["operationIndex"], o["operationType"], o["status"])
                for o in report["operations"]
            ] == [(0, "alter_table_add_column", "completed"), (1, "create_view", "failed")]

        preview = _parse(_migrate(["--abandon", m, "--json"]))
        assert preview["mode"] == "plan"
        check_report(preview["abandon"])
        _wait_journal(
            project, m, lambda r: r.checksum == checksum_sql(v1) and r.statuses == "completed,failed"
        )

        performed = _parse(_migrate(["--abandon", m, "--apply", "--json"]))
        assert performed["mode"] == "execute"
        check_report(performed["abandon"])
        _wait_journal(
            project,
            m,
            lambda r: r.checksum == checksum_sql(v1)
            and r.completed == 0
            and r.statuses == "failed,failed",
        )

        # Abandoning again keeps the record that statement 1 completed.
        was_completed = "abandoned via chkit migrate --abandon (was completed)"
        again = _parse(_migrate(["--abandon", m, "--apply", "--json"]))
        assert again["abandon"]["completedStatements"] == 1
        assert again["abandon"]["operations"][0]["lastError"] == was_completed
        _wait_journal(project, m, lambda r: r.statuses == "failed,failed")
        kept = _parse(_migrate(["--abandon", m, "--json"]))
        assert kept["abandon"]["completedStatements"] == 1
        assert kept["abandon"]["operations"][0]["lastError"] == was_completed

        # Nothing is recorded as completed any more, so the edited file runs
        # again from statement 1 without --retry.
        rerun = _migrate(["--execute", "--json"])
        assert rerun.exit_code == 0, format_test_diagnostic("apply after abandon", rerun)
        assert (
            f"{m} changed since its last failed attempt; no statement is recorded as "
            "completed, so it runs again from statement 1." in rerun.stderr
        )
        applied = _parse(rerun)["applied"]
        assert [(e["name"], e["checksum"]) for e in applied] == [(m, checksum_sql(v3))]
        wait_for_table(project.client, db, b)
        wait_for_view(project.client, db, v)
        _wait_journal(
            project,
            m,
            lambda r: r.completed == 1
            and r.checksum == checksum_sql(v3)
            and r.statuses == "completed,completed,completed",
        )

        applied2 = _migrate(["--abandon", m, "--json"])
        assert applied2.exit_code == 1
        assert _error_of(applied2)["code"] == "migration_already_applied"
        unknown = _migrate(["--abandon", "20990101000009_never_ran.sql", "--json"])
        assert unknown.exit_code == 1
        assert _error_of(unknown)["code"] == "migration_not_in_progress"
    finally:
        _drop(project, views=[v], tables=[a, b])


def test_abandon_needs_neither_file_nor_parseable_snapshot(
    make_project: Callable[[str], Project],
) -> None:
    project = make_project("abandon_gone")
    db, prefix = project.database, project.prefix
    a, b, v = f"{prefix}a", f"{prefix}b", f"{prefix}v"
    m = "20990101000000_gone.sql"
    try:
        _create_table(project, a)
        _write(project, m, _three_statement_migration(db=db, a=a, v=v, view_source=b, b=b))
        run1 = _migrate(["--execute", "--json"])
        assert run1.exit_code == 1
        assert f"Migration {m} failed at statement 2 of 3" in _error_of(run1)["message"]
        _wait_journal(project, m, lambda r: r.statuses == "completed,failed")

        project.meta_dir.mkdir(parents=True, exist_ok=True)
        (project.meta_dir / "snapshot.json").write_text(
            '<<<<<<< HEAD\n{"version":1}\n=======\n{"version":1,"definitions":[]}\n>>>>>>> feature\n',
            encoding="utf-8",
        )
        (project.migrations_dir / m).unlink()

        # A plain migrate cannot read the conflicted snapshot.
        blocked = _migrate(["--json"])
        assert blocked.exit_code != 0

        preview = _migrate(["--abandon", m])
        assert preview.exit_code == 0, format_test_diagnostic("abandon preview", preview)
        assert "Nothing has changed yet." in preview.stdout
        assert "1 completed statement(s) remain applied in ClickHouse:" in preview.stdout
        assert f"{m} is no longer in the migrations directory" in preview.stdout
        assert "Plan only. Re-run with --apply" in preview.stdout
        _wait_journal(project, m, lambda r: r.statuses == "completed,failed")

        performed = _migrate(["--abandon", m, "--apply"])
        assert performed.exit_code == 0, format_test_diagnostic("abandon", performed)
        assert f"Abandoned in-progress migration {m}" in performed.stdout
        _wait_journal(project, m, lambda r: r.completed == 0 and r.statuses == "failed,failed")
    finally:
        _drop(project, views=[v], tables=[a, b])


def test_apply_refuses_pending_files_without_statements(
    make_project: Callable[[str], Project],
) -> None:
    project = make_project("empty_mig")
    db, t = project.database, f"{project.prefix}t"
    real, stub, note = (
        "20990101000000_real.sql",
        "20990101000001_stub.sql",
        "20990101000002_note.sql",
    )
    try:
        _write(project, real, f"CREATE TABLE IF NOT EXISTS {db}.{t} (id UInt64) ENGINE = MergeTree ORDER BY id;\n")
        scaffold = CliRunner().invoke(
            app,
            ["generate", "--empty", "--name", "stub", "--migration-id", "20990101000001", "--json"],
        )
        assert scaffold.exit_code == 0, format_test_diagnostic("generate --empty", scaffold)
        assert json.loads(scaffold.stdout)["migrationFile"].endswith(stub)
        _write(project, note, "/* backfill goes here */\n")

        plan = _parse(_migrate(["--json"]))
        assert plan["pending"] == [real, stub, note]
        assert plan["emptyMigrations"] == [stub, note]
        # An empty file has nothing to resume, so --retry has no effect on it.
        empty_retry = _parse(_migrate(["--json", "--retry", stub]))
        assert empty_retry["retry"] == {"action": "none", "migration": stub, "reason": "empty_migration"}
        assert empty_retry["emptyMigrations"] == [stub, note]

        blocked = _migrate(["--execute", "--json"])
        assert blocked.exit_code == 1
        payload = json.loads(blocked.stdout)
        assert payload["mode"] == "execute"
        assert payload["error"] == EMPTY_MIGRATIONS_SUMMARY
        assert payload["emptyMigrations"] == [stub, note]
        assert "applied" not in payload

        blocked_text = _migrate(["--execute"])
        assert blocked_text.exit_code == 1
        assert "contain no executable statements" in blocked_text.stderr
        assert stub in blocked_text.stderr

        # Nothing ran and nothing was journaled.
        assert (
            _count(
                project,
                "SELECT toString(count()) AS n FROM system.tables "
                f"WHERE database = '{db}' AND name = '{t}'",
            )
            == 0
        )
        journal_exists = _count(
            project,
            "SELECT toString(count()) AS n FROM system.tables "
            f"WHERE database = '{db}' AND name = '{project.journal_table}'",
        )
        if journal_exists:
            assert (
                _count(
                    project,
                    "SELECT toString(count()) AS n FROM "
                    f"{quote_ident(db)}.{quote_ident(project.journal_table)} FINAL",
                )
                == 0
            )

        # Fill in the stub, drop the note: both remaining files apply.
        with (project.migrations_dir / stub).open("a", encoding="utf-8") as handle:
            handle.write(f"INSERT INTO {db}.{t} VALUES (1);\n")
        (project.migrations_dir / note).unlink()
        applied = _migrate(["--execute", "--json"])
        assert applied.exit_code == 0, format_test_diagnostic("apply filled stub", applied)
        assert [e["name"] for e in _parse(applied)["applied"]] == [real, stub]
        _wait_rows(
            project,
            f"SELECT toString(count()) AS n FROM {quote_ident(db)}.{quote_ident(t)}",
            lambda rows: int(rows[0]["n"]) == 1,
            "empty-migration: stub insert visible",
        )
    finally:
        _drop(project, views=[], tables=[t])


def test_abandoned_async_load_failing_before_start_is_not_journaled_completed(
    make_project: Callable[[str], Project],
) -> None:
    """The deterministic query id keeps the first run's QueryFinish in query_log.

    An edited load that fails before it starts must not inherit that success,
    and the abandoned load's ``-- before-retry:`` line runs before every later
    attempt so the load never adds its rows twice.
    """
    project = make_project("abandon_async")
    db, prefix = project.database, project.prefix
    src, dst, v = f"{prefix}src", f"{prefix}dst", f"{prefix}v"
    # The query id is global on the server: a per-run file name keeps
    # concurrent runs from sharing it.
    m = f"20990101000000_{prefix}load.sql"

    def dst_rows(expected: int, label: str) -> None:
        _wait_rows(
            project,
            f"SELECT toString(count()) AS n FROM {quote_ident(db)}.{quote_ident(dst)}",
            lambda rows: int(rows[0]["n"]) == expected,
            label,
        )

    def migration(load_source: str, view_source: str) -> str:
        return "\n".join(
            [
                f"-- operation: load_table_data key=table:{db}.{dst} risk=caution mode=async",
                f"-- before-retry: TRUNCATE TABLE {db}.{dst}",
                f"INSERT INTO {db}.{dst} SELECT id FROM {db}.{load_source};",
                "",
                f"-- operation: create_view key=view:{db}.{v} risk=safe",
                f"CREATE VIEW {db}.{v} AS SELECT id FROM {db}.{view_source};",
                "",
            ]
        )

    try:
        _create_table(project, src)
        project.client.execute(
            f"INSERT INTO {quote_ident(db)}.{quote_ident(src)} VALUES (1), (2)"
        )
        _create_table(project, dst)

        _write(project, m, migration(src, f"{prefix}missing"))
        run1 = _migrate(["--execute", "--json"])
        assert run1.exit_code == 1
        # Async progress goes to stderr, so stdout holds only the JSON envelope.
        assert f"Migration {m} failed at statement 2 of 2" in _error_of(run1)["message"]
        assert "load_table_data: finished" in run1.stderr
        _wait_journal(project, m, lambda r: r.statuses == "completed,failed")
        dst_rows(2, "abandon-async: first load visible")

        abandoned = _migrate(["--abandon", m, "--apply", "--json"])
        assert abandoned.exit_code == 0, format_test_diagnostic("abandon", abandoned)
        _wait_journal(project, m, lambda r: r.statuses == "failed,failed")

        _write(project, m, migration(f"{src}_typo", src))
        run2 = _migrate(["--execute", "--json"])
        assert run2.exit_code == 1, format_test_diagnostic("edited load", run2)
        assert f"Migration {m} failed at statement 1 of 2" in _error_of(run2)["message"]
        assert f"{src}_typo" in _error_of(run2)["message"]
        _wait_journal(project, m, lambda r: r.completed == 0 and r.statuses == "failed,failed")
        # The abandoned load took the retry path: its -- before-retry: line
        # emptied the table before the edited load failed.
        assert "load_table_data: running before-retry SQL" in run2.stderr
        dst_rows(0, "abandon-async: before-retry emptied the table")
        assert (
            _count(
                project,
                "SELECT toString(count()) AS n FROM system.tables "
                f"WHERE database = '{db}' AND name = '{v}'",
            )
            == 0
        )

        # Nothing completed, so the fixed file runs again without --retry.
        _write(project, m, migration(src, src))
        run3 = _migrate(["--execute", "--json"])
        assert run3.exit_code == 0, format_test_diagnostic("fixed load", run3)
        wait_for_view(project.client, db, v)
        _wait_journal(project, m, lambda r: r.completed == 1 and r.statuses == "completed,completed")
        dst_rows(2, "abandon-async: the fixed load added its rows once")
    finally:
        _drop(project, views=[v], tables=[src, dst])
