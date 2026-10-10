"""Unit tests for ``migrate --retry`` / ``--abandon`` and empty migrations (#233).

Ports of the TS ``commands/migrate/{recovery,retry,abandon,abandon-command,
abandon-output,retry-output,empty,apply-resume}.test.ts`` and
``migrate-recovery-usage.test.ts``.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from typer.testing import CliRunner

from chkit.cli.commands import migrate_apply
from chkit.cli.commands.migrate import AbandonContext, run_abandon
from chkit.cli.commands.migrate_abandon import (
    AbandonReport,
    abandon_migration_state,
    abandon_report,
    read_abandonable_state,
    status_before_abandon,
)
from chkit.cli.commands.migrate_apply import ApplyMigrationInput, apply_migration
from chkit.cli.commands.migrate_empty import find_empty_migrations
from chkit.cli.commands.migrate_errors import (
    MigrateError,
    empty_migrations_error,
    in_progress_checksum_mismatch_error,
)
from chkit.cli.commands.migrate_output import format_retry_notice, render_abandon_text
from chkit.cli.commands.migrate_recovery import (
    Marker,
    OperationMismatch,
    RecordedStatement,
    RetryEditMismatch,
    RetryEditOk,
    SharedMarkerMismatch,
    StatementIdentity,
    has_statement_progress,
    normalize_migration_name,
    rebase_in_progress_state,
    resolve_recovery_targets,
    retry_mismatch_error,
    statement_identities,
    statement_identity,
    verify_retry_edit,
)
from chkit.cli.commands.migrate_retry import RetryNoop, RetryResume, resolve_retry
from chkit.cli.journal_store import MigrationRowState, OperationState
from chkit.cli.main import app
from chkit.cli.migration_store import MigrationJournalEntry, checksum_sql
from chkit.cli.safety_markers import MigrationOperationSummary
from chkit.clickhouse.client import QueryResult
from chkit.core.sql_splitter import extract_executable_statements, split_sql_statements

pytestmark = pytest.mark.usefixtures("single_replica")

A = Marker(type="create_table", key="table:db.a")
B = Marker(type="create_table", key="table:db.b")
V = Marker(type="create_view", key="view:db.v")
LOAD = Marker(type="load_table_data", key="table:db.a")
MODIFY_F = Marker(type="alter_table_modify_column", key="table:db.t:column:f")


def op(
    index: int,
    status: str,
    identity: Marker | None = None,
    *,
    query_id: str = "",
    last_error: str | None = None,
) -> OperationState:
    marker = identity or Marker(type="sql_statement", key=f"statement:{index}")
    return OperationState(
        operation_index=index,
        operation_key=marker.key,
        operation_type=marker.type,
        query_id=query_id,
        status=status,  # type: ignore[arg-type]
        started_at="2026-09-29 00:11:10.000",
        finished_at=None if status == "started" else "2026-09-29 00:11:11.000",
        last_error=(
            last_error
            if last_error is not None
            else ("Code: 60. Unknown table" if status == "failed" else "")
        ),
    )


def in_progress(
    operations: list[OperationState], *, checksum: str = "c", completed: bool = False
) -> MigrationRowState:
    return MigrationRowState(
        name="m.sql",
        applied_at="2026-09-29 00:11:11.000",
        checksum=checksum,
        chkit_version="0.2.0-test",
        migration_completed=completed,
        operations=operations,
    )


def identities(*markers: Marker) -> list[StatementIdentity]:
    return [StatementIdentity(type=m.type, key=m.key, marked=True) for m in markers]


def summary(type_: str, key: str) -> MigrationOperationSummary:
    return MigrationOperationSummary(
        type=type_,
        key=key,
        risk="safe",
        mode="sync",
        before_retry=None,
        summary=f"{type_} key={key} risk=safe",
    )


@dataclass
class FakeStore:
    state: MigrationRowState | None = None
    reads: list[str] = field(default_factory=list)
    writes: list[MigrationRowState] = field(default_factory=list)
    appended: list[MigrationJournalEntry] = field(default_factory=list)

    def read_migration_state(self, name: str) -> MigrationRowState | None:
        self.reads.append(name)
        return self.state

    def write_migration_state(self, state: MigrationRowState) -> None:
        self.writes.append(state)
        self.state = state

    def append_entry(self, entry: MigrationJournalEntry, *, chkit_version: str) -> None:
        _ = chkit_version
        self.appended.append(entry)
        if self.state is not None:
            self.state = self.state.model_copy(
                update={"checksum": entry.checksum, "migration_completed": True}
            )


# ---------- normalize_migration_name / resolve_recovery_targets ----------


def test_normalize_migration_name_accepts_names_and_paths() -> None:
    assert normalize_migration_name("20260101000000_a.sql", "--retry") == "20260101000000_a.sql"
    assert normalize_migration_name("20260101000000_a", "--retry") == "20260101000000_a.sql"
    assert (
        normalize_migration_name("chkit/migrations/20260101000000_a.sql", "--retry")
        == "20260101000000_a.sql"
    )
    assert normalize_migration_name("  C:\\p\\migrations\\x.sql  ", "--abandon") == "x.sql"


@pytest.mark.parametrize("raw", ["", "  ", "dir/", ".sql"])
def test_normalize_migration_name_rejects_empty(raw: str) -> None:
    with pytest.raises(MigrateError, match="--retry requires a migration file name") as info:
        normalize_migration_name(raw, "--retry")
    assert info.value.code == "invalid_usage"


def test_resolve_recovery_targets() -> None:
    none = resolve_recovery_targets(retry=None, abandon=None)
    assert (none.retry_target, none.abandon_target) == (None, None)
    retry = resolve_recovery_targets(retry="m", abandon=None)
    assert retry.retry_target == "m.sql"
    abandon = resolve_recovery_targets(retry=None, abandon="x")
    assert abandon.abandon_target == "x.sql"


def test_resolve_recovery_targets_rejects_abandon_with_other_flags() -> None:
    with pytest.raises(
        MigrateError,
        match="--abandon cannot be combined with --retry, --table, --allow-destructive",
    ):
        resolve_recovery_targets(
            retry="y", abandon="x", table="app.users", allow_destructive=True
        )
    with pytest.raises(MigrateError) as info:
        resolve_recovery_targets(retry=None, abandon="x", table="app.users")
    assert info.value.code == "invalid_usage"


# ---------- statement_identity / verify_retry_edit ----------


def test_statement_identity_uses_marker_or_position() -> None:
    operations = [summary("create_table", "table:db.a")]
    assert statement_identity(operations, 0) == StatementIdentity(
        type="create_table", key="table:db.a", marked=True
    )
    assert statement_identity(operations, 1) == StatementIdentity(
        type="sql_statement", key="statement:1", marked=False
    )
    assert len(statement_identities(operations, 2)) == 2


def test_verify_retry_edit_accepts_kept_completed_prefix() -> None:
    result = verify_retry_edit(
        [op(0, "completed", A), op(1, "completed", B), op(2, "failed", V)],
        identities(A, B, Marker(type="create_view", key="view:db.w"), V),
    )
    assert result == RetryEditOk(completed=2, unmarked_completed=0, resume_index=2)


def test_verify_retry_edit_rejects_changed_marker() -> None:
    result = verify_retry_edit([op(0, "completed", A), op(1, "failed", V)], identities(B, V))
    assert result == RetryEditMismatch(
        mismatches=[
            OperationMismatch(statement=1, status="completed", query_id="", recorded=A, current=B)
        ],
        shared_markers=[],
    )


def test_verify_retry_edit_rejects_missing_statement() -> None:
    result = verify_retry_edit([op(3, "completed", A)], identities(A, B, V))
    assert isinstance(result, RetryEditMismatch)
    assert result.mismatches == [
        OperationMismatch(statement=4, status="completed", query_id="", recorded=A, current=None)
    ]


def test_verify_retry_edit_matches_unmarked_statements_by_position() -> None:
    result = verify_retry_edit(
        [op(0, "completed"), op(1, "completed")], statement_identities([], 3)
    )
    assert result == RetryEditOk(completed=2, unmarked_completed=2, resume_index=2)


def test_verify_retry_edit_resume_index_bounds() -> None:
    assert verify_retry_edit([op(0, "failed", A)], identities(B)) == RetryEditOk(
        completed=0, unmarked_completed=0, resume_index=0
    )
    assert verify_retry_edit(
        [op(0, "completed", A), op(1, "completed", B)], identities(A, B)
    ) == RetryEditOk(completed=2, unmarked_completed=0, resume_index=None)


def test_verify_retry_edit_ignores_failed_and_unsubmitted_started() -> None:
    result = verify_retry_edit(
        [op(0, "completed", A), op(1, "failed", V), op(2, "started", B)],
        identities(A, B, V),
    )
    assert result == RetryEditOk(completed=1, unmarked_completed=0, resume_index=1)


def test_verify_retry_edit_rejects_moved_running_async_statement() -> None:
    result = verify_retry_edit(
        [op(0, "completed", A), op(1, "started", LOAD, query_id="q-1")], identities(A, V)
    )
    assert result == RetryEditMismatch(
        mismatches=[
            OperationMismatch(
                statement=2, status="started", query_id="q-1", recorded=LOAD, current=V
            )
        ],
        shared_markers=[],
    )
    assert verify_retry_edit(
        [op(1, "started", LOAD, query_id="q-1")], identities(A, LOAD)
    ) == RetryEditOk(completed=0, unmarked_completed=0, resume_index=0)


_REMOVE_THEN_MODIFY = [op(0, "completed", MODIFY_F), op(1, "failed", MODIFY_F)]
_SHARED = SharedMarkerMismatch(
    type=MODIFY_F.type,
    key=MODIFY_F.key,
    recorded=[
        RecordedStatement(statement=1, status="completed"),
        RecordedStatement(statement=2, status="failed"),
    ],
    current_count=1,
)


def test_verify_retry_edit_rejects_deleting_completed_shared_marker() -> None:
    expected = RetryEditMismatch(mismatches=[], shared_markers=[_SHARED])
    assert verify_retry_edit(_REMOVE_THEN_MODIFY, identities(MODIFY_F)) == expected
    assert verify_retry_edit(_REMOVE_THEN_MODIFY, identities(MODIFY_F, V)) == expected
    assert verify_retry_edit(_REMOVE_THEN_MODIFY, identities(MODIFY_F, A)) == expected


def test_verify_retry_edit_accepts_kept_shared_markers() -> None:
    ok = RetryEditOk(completed=1, unmarked_completed=0, resume_index=1)
    assert verify_retry_edit(_REMOVE_THEN_MODIFY, identities(MODIFY_F, MODIFY_F)) == ok
    assert verify_retry_edit(_REMOVE_THEN_MODIFY, identities(MODIFY_F, A, MODIFY_F)) == ok


def test_verify_retry_edit_reports_moved_shared_marker_once() -> None:
    result = verify_retry_edit(
        [op(0, "completed", MODIFY_F), op(1, "completed", MODIFY_F), op(2, "failed", V)],
        identities(MODIFY_F, V),
    )
    assert result == RetryEditMismatch(
        mismatches=[
            OperationMismatch(
                statement=2, status="completed", query_id="", recorded=MODIFY_F, current=V
            )
        ],
        shared_markers=[],
    )


def test_verify_retry_edit_after_abandon_has_no_shared_check() -> None:
    assert verify_retry_edit(
        [op(0, "failed", MODIFY_F), op(1, "failed", MODIFY_F)], identities(MODIFY_F)
    ) == RetryEditOk(completed=0, unmarked_completed=0, resume_index=0)


# ---------- errors ----------


def test_retry_mismatch_error_names_mismatches_and_kill_query() -> None:
    error = retry_mismatch_error(
        "m.sql",
        RetryEditMismatch(
            mismatches=[
                OperationMismatch(
                    statement=1, status="completed", query_id="", recorded=A, current=B
                ),
                OperationMismatch(
                    statement=2, status="started", query_id="q-1", recorded=LOAD, current=None
                ),
            ],
            shared_markers=[],
        ),
    )
    assert error.code == "retry_mismatch"
    assert (
        "statement 1: completed as create_table table:db.a, but the edited file has "
        "create_table table:db.b there" in error.message
    )
    assert (
        "statement 2: started as load_table_data table:db.a (async query_id q-1)"
        in error.message
    )
    assert "the edited file has no statement 2" in error.message
    assert "KILL QUERY WHERE query_id = 'q-1'" in error.message
    assert "chkit migrate --apply --abandon m.sql" in error.message
    assert "share a marker" not in error.message


def test_retry_mismatch_error_names_shared_markers() -> None:
    error = retry_mismatch_error(
        "m.sql",
        RetryEditMismatch(
            mismatches=[],
            shared_markers=[
                SharedMarkerMismatch(
                    type=MODIFY_F.type,
                    key=MODIFY_F.key,
                    recorded=[
                        RecordedStatement(statement=1, status="completed"),
                        RecordedStatement(statement=2, status="completed"),
                        RecordedStatement(statement=3, status="failed"),
                    ],
                    current_count=2,
                )
            ],
        ),
    )
    assert (
        "  statements 1 (completed), 2 (completed) and 3 (failed) share "
        "alter_table_modify_column table:db.t:column:f, but the edited file has 2 "
        "statements with that marker" in error.message
    )
    assert "Keep each of them and edit only the one that failed." in error.message


def test_rebase_in_progress_state_keeps_completed_and_unchanged() -> None:
    state = in_progress(
        [
            op(0, "completed", A),
            op(1, "failed", B),
            op(2, "started", LOAD, query_id="q-2"),
            op(5, "failed", V),
        ],
        checksum="old",
    )
    rebased = rebase_in_progress_state(
        state, checksum="new", identities=identities(A, B, V), applied_at="T"
    )
    assert rebased == state.model_copy(
        update={
            "checksum": "new",
            "applied_at": "T",
            "operations": [op(0, "completed", A), op(1, "failed", B)],
        }
    )


def test_has_statement_progress() -> None:
    assert not has_statement_progress(in_progress([]))
    assert not has_statement_progress(in_progress([op(0, "failed", A)]))
    assert has_statement_progress(in_progress([op(0, "completed", A)]))
    assert has_statement_progress(in_progress([op(0, "started", A)]))


def test_in_progress_checksum_mismatch_error_names_both_commands() -> None:
    error = in_progress_checksum_mismatch_error(
        migration="m.sql", journal_checksum="a", file_checksum="b", is_async=False
    )
    assert error.code == "in_progress_checksum_mismatch"
    assert "in-progress journal state for checksum a" in error.message
    assert "the current file checksum is b" in error.message
    assert "chkit migrate --apply --retry m.sql" in error.message
    assert "chkit migrate --apply --abandon m.sql" in error.message
    async_error = in_progress_checksum_mismatch_error(
        migration="m.sql", journal_checksum="a", file_checksum="b", is_async=True
    )
    assert "in-progress async journal state" in async_error.message


def test_empty_migrations_error_lists_every_file() -> None:
    message = str(empty_migrations_error(["a.sql", "b.sql"]))
    assert "contain no executable statements" in message
    assert "  - a.sql\n  - b.sql" in message


# ---------- resolve_retry ----------

RETRY_SQL = "\n".join(
    [
        "-- operation: alter_table_add_column key=table:db.a risk=safe",
        "ALTER TABLE db.a ADD COLUMN c1 UInt64;",
        "",
        "-- operation: create_table key=table:db.b risk=safe",
        "CREATE TABLE db.b (id UInt64) ENGINE = MergeTree ORDER BY id;",
        "",
        "-- operation: create_view key=view:db.v risk=safe",
        "CREATE VIEW db.v AS SELECT id FROM db.b;",
        "",
    ]
)


@pytest.fixture
def retry_dir(tmp_path: Path) -> Path:
    (tmp_path / "m.sql").write_text(RETRY_SQL, encoding="utf-8")
    return tmp_path


def _resolve(
    migrations_dir: Path,
    store: FakeStore,
    *,
    pending: list[str] | None = None,
    empty: list[str] | None = None,
    applied: set[str] | None = None,
) -> RetryNoop | RetryResume:
    return resolve_retry(
        migration="m.sql",
        migrations_dir=migrations_dir,
        pending=["m.sql"] if pending is None else pending,
        empty_migrations=empty or [],
        applied_names=applied or set(),
        journal_store=store,
    )


def test_resolve_retry_noops(retry_dir: Path) -> None:
    store = FakeStore()
    assert _resolve(retry_dir, store, applied={"m.sql"}) == RetryNoop(
        migration="m.sql", reason="already_applied"
    )
    assert store.reads == []
    assert _resolve(retry_dir, store, pending=[]).reason == "not_in_scope"  # type: ignore[union-attr]
    failed = FakeStore(in_progress([op(0, "failed", V)]))
    assert _resolve(retry_dir, failed, empty=["m.sql"]).reason == "empty_migration"  # type: ignore[union-attr]
    assert failed.reads == []
    assert _resolve(retry_dir, FakeStore()).reason == "not_in_progress"  # type: ignore[union-attr]
    completed = FakeStore(in_progress([], completed=True))
    assert _resolve(retry_dir, completed).reason == "already_applied"  # type: ignore[union-attr]
    unchanged = FakeStore(in_progress([], checksum=checksum_sql(RETRY_SQL)))
    assert _resolve(retry_dir, unchanged).reason == "checksum_unchanged"  # type: ignore[union-attr]


def test_resolve_retry_resumes_at_first_incomplete(retry_dir: Path) -> None:
    store = FakeStore(
        in_progress(
            [
                op(0, "completed", Marker(type="alter_table_add_column", key="table:db.a")),
                op(1, "failed", V),
            ],
            checksum="old",
        )
    )
    result = _resolve(retry_dir, store)
    assert result == RetryResume(
        migration="m.sql",
        previous_checksum="old",
        checksum=checksum_sql(RETRY_SQL),
        total_statements=3,
        completed_statements=1,
        resume_at_statement=2,
        unmarked_completed_statements=0,
    )
    assert result.model_dump(by_alias=True) == {
        "action": "resume",
        "migration": "m.sql",
        "previousChecksum": "old",
        "checksum": checksum_sql(RETRY_SQL),
        "totalStatements": 3,
        "completedStatements": 1,
        "resumeAtStatement": 2,
        "unmarkedCompletedStatements": 0,
    }
    assert store.writes == []


def test_resolve_retry_refuses_changed_completed_statement(retry_dir: Path) -> None:
    store = FakeStore(
        in_progress(
            [op(0, "completed", Marker(type="create_table", key="table:db.x"))],
            checksum="old",
        )
    )
    with pytest.raises(MigrateError) as info:
        _resolve(retry_dir, store)
    assert info.value.code == "retry_mismatch"
    assert "statement 1: completed as create_table table:db.x" in info.value.message


def test_resolve_retry_refuses_fewer_shared_markers(retry_dir: Path) -> None:
    add_a = Marker(type="alter_table_add_column", key="table:db.a")
    store = FakeStore(in_progress([op(0, "completed", add_a), op(1, "failed", add_a)], checksum="old"))
    with pytest.raises(MigrateError) as info:
        _resolve(retry_dir, store)
    assert (
        "statements 1 (completed) and 2 (failed) share alter_table_add_column "
        "table:db.a, but the edited file has 1 statement with that marker"
        in info.value.message
    )


# ---------- abandon ----------

_NOON = datetime(2026, 9, 30, 12, 0, 0, tzinfo=UTC)


def _abandon_op(index: int, status: str, **extra: Any) -> OperationState:
    base = op(index, status, Marker(type="create_table", key=f"table:db.t{index}"))
    return base.model_copy(update=extra)


def test_read_abandonable_state_refusals() -> None:
    store = FakeStore()
    with pytest.raises(MigrateError) as info:
        read_abandonable_state(migration="m.sql", applied_names={"m.sql"}, journal_store=store)
    assert info.value.code == "migration_already_applied"
    assert store.reads == []
    with pytest.raises(MigrateError) as info:
        read_abandonable_state(migration="m.sql", applied_names=set(), journal_store=store)
    assert info.value.code == "migration_not_in_progress"
    assert info.value.message == (
        "Cannot abandon m.sql: the journal has no in-progress state for it."
    )
    done = FakeStore(in_progress([_abandon_op(0, "completed")], completed=True))
    with pytest.raises(MigrateError) as info:
        read_abandonable_state(migration="m.sql", applied_names=set(), journal_store=done)
    assert info.value.code == "migration_already_applied"


def test_read_abandonable_state_returns_state() -> None:
    state = in_progress([_abandon_op(0, "completed"), _abandon_op(1, "failed")])
    store = FakeStore(state)
    assert (
        read_abandonable_state(migration="m.sql", applied_names=set(), journal_store=store)
        == state
    )
    assert store.writes == []


def test_abandon_migration_state_marks_every_statement_failed() -> None:
    state = in_progress(
        [
            _abandon_op(0, "completed", operation_type="load_table_data", query_id="q-0"),
            _abandon_op(1, "failed"),
            _abandon_op(2, "started", query_id="q-2"),
        ]
    )
    store = FakeStore(state)
    abandon_migration_state(state, journal_store=store, now=lambda: _NOON)
    assert store.writes == [
        state.model_copy(
            update={
                "applied_at": "2026-09-30T12:00:00.000",
                "migration_completed": False,
                "operations": [
                    state.operations[0].model_copy(
                        update={
                            "status": "failed",
                            "last_error": "abandoned via chkit migrate --abandon (was completed)",
                        }
                    ),
                    state.operations[1].model_copy(
                        update={
                            "last_error": "abandoned via chkit migrate --abandon (was failed)"
                        }
                    ),
                    state.operations[2].model_copy(
                        update={
                            "status": "failed",
                            "finished_at": "2026-09-30T12:00:00.000",
                            "last_error": "abandoned via chkit migrate --abandon (was started)",
                        }
                    ),
                ],
            }
        )
    ]


def test_abandon_again_keeps_earlier_abandon_records() -> None:
    earlier = [
        _abandon_op(0, "failed", last_error="abandoned via chkit migrate --abandon (was completed)"),
        _abandon_op(
            1, "failed", last_error="abandoned via chkit migrate --abandon (was started)", query_id="q-1"
        ),
    ]
    state = in_progress([*earlier, _abandon_op(2, "completed"), _abandon_op(3, "failed")])
    store = FakeStore(state)
    abandon_migration_state(state, journal_store=store, now=lambda: _NOON)
    assert store.writes[0].operations == [
        *earlier,
        _abandon_op(2, "completed").model_copy(
            update={
                "status": "failed",
                "last_error": "abandoned via chkit migrate --abandon (was completed)",
            }
        ),
        _abandon_op(3, "failed").model_copy(
            update={"last_error": "abandoned via chkit migrate --abandon (was failed)"}
        ),
    ]


def test_abandon_report_sorts_and_counts() -> None:
    report = abandon_report(in_progress([_abandon_op(1, "failed"), _abandon_op(0, "completed")]))
    assert report == AbandonReport(
        migration="m.sql",
        checksum="c",
        completed_statements=1,
        operations=[_abandon_op(0, "completed"), _abandon_op(1, "failed")],
    )
    payload = report.to_payload()
    assert payload["completedStatements"] == 1
    assert payload["operations"][0]["operationIndex"] == 0
    again = abandon_report(
        in_progress(
            [
                _abandon_op(0, "failed", last_error="abandoned via chkit migrate --abandon (was completed)"),
                _abandon_op(1, "failed", last_error="abandoned via chkit migrate --abandon (was failed)"),
            ]
        )
    )
    assert again.completed_statements == 1


def test_status_before_abandon() -> None:
    assert (
        status_before_abandon(
            _abandon_op(0, "failed", last_error="abandoned via chkit migrate --abandon (was completed)")
        )
        == "completed"
    )
    assert (
        status_before_abandon(
            _abandon_op(0, "failed", last_error="abandoned via chkit migrate --abandon (was started)")
        )
        == "started"
    )
    assert status_before_abandon(_abandon_op(0, "failed")) == "failed"
    assert status_before_abandon(_abandon_op(0, "completed")) == "completed"
    assert (
        status_before_abandon(
            _abandon_op(
                0, "failed", last_error="Code: 62. abandoned via chkit migrate --abandon (was completed)"
            )
        )
        == "failed"
    )


# ---------- run_abandon (prompt behaviour) ----------


def _abandon_store() -> FakeStore:
    return FakeStore(in_progress([_abandon_op(0, "completed"), _abandon_op(1, "failed")]))


def _abandon_ctx(store: FakeStore, *, execute: bool = False) -> AbandonContext:
    return AbandonContext(
        json_mode=False,
        execute_requested=execute,
        journal_store=store,
        applied_names=set(),
        files=["m.sql"],
        meta_dir=Path.cwd() / "chkit/meta",
    )


def _confirm(asked: list[str], *, answer: bool) -> Callable[[str], bool]:
    def confirm(migration: str) -> bool:
        asked.append(migration)
        return answer

    return confirm


def test_run_abandon_non_interactive_previews_only(capsys: pytest.CaptureFixture[str]) -> None:
    store = _abandon_store()
    asked: list[str] = []
    run_abandon("m.sql", _abandon_ctx(store), is_interactive=lambda: False, confirm=_confirm(asked, answer=True))
    lines = capsys.readouterr().out.splitlines()
    assert asked == []
    assert store.writes == []
    assert "Nothing has changed yet." in lines[0]
    assert lines[-1] == "Plan only. Re-run with --apply to abandon the in-progress state."


def test_run_abandon_interactive_decline(capsys: pytest.CaptureFixture[str]) -> None:
    store = _abandon_store()
    asked: list[str] = []
    run_abandon("m.sql", _abandon_ctx(store), is_interactive=lambda: True, confirm=_confirm(asked, answer=False))
    assert asked == ["m.sql"]
    assert store.writes == []
    assert "Abandon cancelled by user." in capsys.readouterr().out.splitlines()


def test_run_abandon_interactive_confirm(capsys: pytest.CaptureFixture[str]) -> None:
    store = _abandon_store()
    asked: list[str] = []
    run_abandon("m.sql", _abandon_ctx(store), is_interactive=lambda: True, confirm=_confirm(asked, answer=True))
    assert asked == ["m.sql"]
    assert [o.status for o in store.writes[0].operations] == ["failed", "failed"]
    assert capsys.readouterr().out.splitlines()[-1] == "Abandoned in-progress migration m.sql."


def test_run_abandon_with_apply_does_not_ask(capsys: pytest.CaptureFixture[str]) -> None:
    store = _abandon_store()
    asked: list[str] = []
    run_abandon(
        "m.sql",
        _abandon_ctx(store, execute=True),
        is_interactive=lambda: True,
        confirm=_confirm(asked, answer=False),
    )
    assert asked == []
    assert len(store.writes) == 1
    assert capsys.readouterr().out.splitlines()[0] == (
        "Abandoned in-progress migration m.sql: every recorded statement is now marked failed."
    )


# ---------- render_abandon_text ----------

_REPORT = AbandonReport(
    migration="20260929001110_funnel-model.sql",
    checksum="c",
    completed_statements=1,
    operations=[
        op(0, "completed", Marker(type="alter_table_add_column", key="table:analytics.events")),
        op(
            1,
            "failed",
            Marker(type="create_table", key="table:analytics.t1"),
            last_error="Code: 60. Unknown table 'analytics.steps'\nStack trace:\n0. DB::Exception",
        ),
        op(2, "started", Marker(type="load_table_data", key="table:analytics.t2"), query_id="q-2"),
    ],
)


def _abandon_lines(
    capsys: pytest.CaptureFixture[str],
    report: AbandonReport,
    *,
    performed: bool,
    file_exists: bool = True,
) -> list[str]:
    render_abandon_text(
        report,
        performed=performed,
        file_exists=file_exists,
        snapshot_file="chkit/meta/snapshot.json",
    )
    return capsys.readouterr().out.splitlines()


def test_render_abandon_text_preview(capsys: pytest.CaptureFixture[str]) -> None:
    lines = _abandon_lines(capsys, _REPORT, performed=False)
    assert lines[0] == (
        "Abandoning in-progress migration 20260929001110_funnel-model.sql marks every "
        "recorded statement failed. Nothing has changed yet."
    )
    assert "1 completed statement(s) remain applied in ClickHouse:" in lines
    assert "  1. alter_table_add_column table:analytics.events" in lines
    assert "Statement 2 failed: Code: 60. Unknown table 'analytics.steps'" in lines
    assert "Statement 3 was interrupted (query_id q-2)." in lines
    assert any("KILL QUERY WHERE query_id = 'q-2'" in line for line in lines)
    assert any(line.startswith("Next: edit 20260929001110_funnel-model.sql") for line in lines)
    assert any("restore chkit/meta/snapshot.json from git" in line for line in lines)
    next_line = next(line for line in lines if line.startswith("Next: edit"))
    assert "before-retry" not in next_line
    assert (
        "A column's MODIFY COLUMN ... REMOVE DEFAULT or REMOVE MATERIALIZED is not safe"
        in next_line
    )


def test_render_abandon_text_after_earlier_abandon(capsys: pytest.CaptureFixture[str]) -> None:
    report = _REPORT.model_copy(
        update={
            "operations": [
                op(
                    0,
                    "failed",
                    Marker(type="alter_table_add_column", key="table:analytics.events"),
                    last_error="abandoned via chkit migrate --abandon (was completed)",
                ),
                op(1, "failed", last_error="abandoned via chkit migrate --abandon (was failed)"),
                op(
                    2,
                    "failed",
                    Marker(type="load_table_data", key="table:analytics.t2"),
                    query_id="q-2",
                    last_error="abandoned via chkit migrate --abandon (was started)",
                ),
            ]
        }
    )
    lines = _abandon_lines(capsys, report, performed=False)
    assert "No statement had completed." not in lines
    assert "  1. alter_table_add_column table:analytics.events" in lines
    assert "Statement 2 failed: abandoned via chkit migrate --abandon (was failed)" in lines
    assert "Statement 3 was interrupted (query_id q-2)." in lines
    assert not any(line.startswith("Statement 1") for line in lines)


def test_render_abandon_text_file_gone(capsys: pytest.CaptureFixture[str]) -> None:
    report = _REPORT.model_copy(
        update={"completed_statements": 0, "operations": [op(0, "failed", last_error="")]}
    )
    lines = _abandon_lines(capsys, report, performed=True, file_exists=False)
    assert "No statement had completed." in lines
    assert "Statement 1 failed." in lines
    assert "is no longer in the migrations directory" in lines[-1]
    assert "The new migration may repeat statements that completed" in lines[-1]


# ---------- retry notice ----------

_RESUME = RetryResume(
    migration="m.sql",
    previous_checksum="old",
    checksum="new",
    total_statements=3,
    completed_statements=1,
    resume_at_statement=2,
    unmarked_completed_statements=0,
)


def test_format_retry_notice() -> None:
    assert format_retry_notice(_RESUME) == [
        "Retry m.sql: the file changed after a failed apply. 1 completed statement(s) "
        "will be skipped; resuming at statement 2 of 3."
    ]
    unmarked = format_retry_notice(_RESUME.model_copy(update={"unmarked_completed_statements": 1}))
    assert unmarked[1] == (
        '⚠ 1 completed statement(s) have no "-- operation:" marker and were matched by '
        "position only. Do not add, remove, or reorder statements above the first "
        "statement that did not complete."
    )
    done = format_retry_notice(
        _RESUME.model_copy(update={"completed_statements": 3, "resume_at_statement": None})
    )
    assert done == [
        "Retry m.sql: the file changed after a failed apply. All 3 statements already "
        "completed; the migration will be recorded as applied."
    ]
    assert format_retry_notice(RetryNoop(migration="m.sql", reason="checksum_unchanged")) == [
        "Retry m.sql: unchanged since it failed; it resumes without --retry."
    ]
    assert format_retry_notice(RetryNoop(migration="m.sql", reason="not_in_scope")) == [
        "Retry m.sql: outside the --table scope; --retry has no effect."
    ]
    assert format_retry_notice(RetryNoop(migration="m.sql", reason="empty_migration")) == [
        "Retry m.sql: no executable statements; --retry has no effect."
    ]


# ---------- empty migrations + splitter ----------


def test_find_empty_migrations(tmp_path: Path) -> None:
    files = {
        "1_real.sql": "CREATE TABLE db.t (id UInt64) ENGINE = MergeTree ORDER BY id;\n",
        "2_stub.sql": "-- chkit-migration-format: v1\n\n-- Empty migration scaffold. Write your SQL statements below.\n",
        "3_note.sql": "/* backfill goes here */\n",
        "4_blank.sql": "\n  \n",
        "5_trailing.sql": "SELECT 1;\n/* done */\n",
    }
    for name, sql in files.items():
        (tmp_path / name).write_text(sql, encoding="utf-8")
    assert find_empty_migrations(tmp_path, list(files)) == [
        "2_stub.sql",
        "3_note.sql",
        "4_blank.sql",
    ]


def test_split_sql_statements_keeps_comment_only_piece() -> None:
    assert split_sql_statements("/* only a comment */;") == ["/* only a comment */;"]


@pytest.mark.parametrize(
    ("sql", "expected"),
    [
        ("/* only a comment */;", []),
        (
            "CREATE TABLE t (id UInt64) ENGINE = Memory;\n/* TODO */\n",
            ["CREATE TABLE t (id UInt64) ENGINE = Memory"],
        ),
        ("-- header\n/* block; with semicolon */\n-- more\n", []),
        ("SELECT 1;\n/* a */ /* b */;\nSELECT 2;", ["SELECT 1", "SELECT 2"]),
        ("# note\n;", []),
        ("#! shebang\n", []),
        ("// note\n;", []),
        ("/* a /* nested */ b */;", []),
        ("SELECT 1;\n// trailing note", ["SELECT 1"]),
        ("SELECT '/* not a comment */';", ["SELECT '/* not a comment */'"]),
        ("SELECT `/*x*/` FROM t;", ["SELECT `/*x*/` FROM t"]),
        ("SELECT '# a; b';\n/* end */", ["SELECT '# a; b'"]),
        # `#x` is not a comment (ClickHouse needs `# ` or `#!`).
        ("#x;", ["#x"]),
        ("SELECT 1;\n/* never closed", ["SELECT 1", "/* never closed"]),
        # ClickHouse reads the whole line as one comment; the splitter cuts it at
        # the `;`, so the file keeps its old split.
        (
            "// DROP TABLE a; DROP TABLE b;\nSELECT 1;",
            ["// DROP TABLE a", "DROP TABLE b", "SELECT 1"],
        ),
        ("# old: DROP TABLE a; DROP TABLE b;\n", ["# old: DROP TABLE a", "DROP TABLE b"]),
        (
            "-- chkit-migration-format: v1\n-- generated-at: 2026-01-01T00:00:00.000Z\n\n"
            "-- Empty migration scaffold. Write your SQL statements below.\n",
            [],
        ),
    ],
)
def test_extract_executable_statements_drops_comment_only(
    sql: str, expected: list[str]
) -> None:
    assert extract_executable_statements(sql) == expected


# ---------- apply_migration (sync resume + edited in-progress, #6 / #233) ----------

EDITED_SQL = "ALTER TABLE t ADD COLUMN a UInt64;\nALTER TABLE t ADD COLUMN b2 UInt64;\n"


class _FakeRuntime:
    def __init__(self, transform: Callable[[list[str]], list[str]] | None = None) -> None:
        self._transform = transform or (lambda statements: statements)

    def run_on_before_apply(self, context: Any) -> list[str]:
        return self._transform(list(context.statements))

    def run_on_after_apply(self, _context: Any) -> None:
        return None


class _RecordingClient:
    def __init__(self, fail: Callable[[str], bool] | None = None) -> None:
        self.calls: list[str] = []
        self.events: list[str] = []
        self._fail = fail

    def execute(self, statement: str) -> None:
        self.calls.append(statement)
        self.events.append("command")
        if self._fail is not None and self._fail(statement):
            msg = f"boom: {statement}"
            raise RuntimeError(msg)

    def query(self, _sql: str) -> QueryResult:
        # wait_for_ddl_propagation: a non-empty row means the object is visible.
        self.events.append("propagation-query")
        return QueryResult(column_names=["x"], rows=[{"x": 1}])


@pytest.fixture(autouse=True)
def _version(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(migrate_apply, "__version__", "0.0.0-test")


def _apply(
    migrations_dir: Path,
    client: _RecordingClient,
    store: FakeStore,
    *,
    retry: RetryResume | None = None,
    runtime: _FakeRuntime | None = None,
    log: Callable[[str], None] | None = None,
) -> MigrationJournalEntry:
    return apply_migration(
        ApplyMigrationInput(
            client=cast(Any, client),
            journal_store=cast(Any, store),
            plugin_runtime=cast(Any, runtime or _FakeRuntime()),
            config=cast(Any, SimpleNamespace(clickhouse=None)),
            table_scope=cast(Any, None),
            migrations_dir=migrations_dir,
            file="m.sql",
            retry=retry,
            log=log or (lambda _line: None),
            warn=lambda _line: None,
        )
    )


def _retry_for(sql: str, previous: str = "old") -> RetryResume:
    return RetryResume(
        migration="m.sql",
        previous_checksum=previous,
        checksum=checksum_sql(sql),
        total_statements=0,
        completed_statements=0,
        resume_at_statement=None,
        unmarked_completed_statements=0,
    )


def _write(tmp_path: Path, sql: str) -> Path:
    (tmp_path / "m.sql").write_text(sql, encoding="utf-8")
    return tmp_path


def test_apply_skips_completed_statement_after_partial_failure(tmp_path: Path) -> None:
    sql = "ALTER TABLE t ADD COLUMN a UInt64;\nALTER TABLE t ADD COLUMN b UInt64;\n"
    fail_b = [True]
    client = _RecordingClient(fail=lambda s: fail_b[0] and "COLUMN b" in s)
    store = FakeStore()
    with pytest.raises(RuntimeError, match="failed at statement 2 of 2") as info:
        _apply(_write(tmp_path, sql), client, store)
    assert "boom: ALTER TABLE t ADD COLUMN b UInt64" in str(info.value)
    assert client.calls == ["ALTER TABLE t ADD COLUMN a UInt64", "ALTER TABLE t ADD COLUMN b UInt64"]
    assert store.state is not None
    assert [(o.operation_index, o.status) for o in store.state.operations] == [
        (0, "completed"),
        (1, "failed"),
    ]
    assert store.appended == []

    fail_b[0] = False
    client.calls.clear()
    _apply(tmp_path, client, store)
    assert client.calls == ["ALTER TABLE t ADD COLUMN b UInt64"]
    assert len(store.appended) == 1


def test_apply_marks_completed_before_ddl_propagation(tmp_path: Path) -> None:
    sql = (
        "-- operation: create_table key=table:default.t risk=safe\n"
        "CREATE TABLE default.t (id UInt64) ENGINE = MergeTree ORDER BY id;\n"
    )
    client = _RecordingClient()

    class _OrderStore(FakeStore):
        def write_migration_state(self, state: MigrationRowState) -> None:
            super().write_migration_state(state)
            if any(o.status == "completed" for o in state.operations):
                client.events.append("completed-write")

    _apply(_write(tmp_path, sql), client, _OrderStore())
    assert client.events == ["command", "completed-write", "propagation-query"]


def test_apply_refuses_edited_file_with_completed_statement(tmp_path: Path) -> None:
    client = _RecordingClient()
    store = FakeStore(in_progress([op(0, "completed"), op(1, "failed")], checksum="old"))
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, EDITED_SQL), client, store)
    assert info.value.code == "in_progress_checksum_mismatch"
    assert "chkit migrate --apply --retry m.sql" in info.value.message
    assert "chkit migrate --apply --abandon m.sql" in info.value.message
    assert client.calls == []
    assert store.writes == []
    assert store.appended == []


def test_apply_retry_rekeys_and_skips_completed(tmp_path: Path) -> None:
    client = _RecordingClient()
    store = FakeStore(in_progress([op(0, "completed"), op(1, "failed")], checksum="old"))
    _apply(_write(tmp_path, EDITED_SQL), client, store, retry=_retry_for(EDITED_SQL))
    new = checksum_sql(EDITED_SQL)
    assert client.calls == ["ALTER TABLE t ADD COLUMN b2 UInt64"]
    assert store.writes[0].checksum == new
    assert [(o.operation_index, o.status) for o in store.writes[0].operations] == [
        (0, "completed"),
        (1, "failed"),
    ]
    assert all(w.checksum == new for w in store.writes)
    assert store.appended[0].checksum == new


def test_apply_refuses_retry_verified_against_other_checksum(tmp_path: Path) -> None:
    client = _RecordingClient()
    store = FakeStore(in_progress([op(0, "completed"), op(1, "failed")], checksum="old"))
    with pytest.raises(MigrateError) as info:
        _apply(
            _write(tmp_path, EDITED_SQL),
            client,
            store,
            retry=_retry_for(EDITED_SQL, previous="other"),
        )
    assert info.value.code == "in_progress_checksum_mismatch"
    assert client.calls == []
    assert store.writes == []


@pytest.mark.parametrize(
    "operations",
    [
        [op(0, "failed")],
        [
            op(0, "failed", last_error="abandoned via chkit migrate --abandon (was completed)"),
            op(1, "failed", last_error="abandoned via chkit migrate --abandon (was failed)"),
        ],
    ],
    ids=["first-statement-failed", "abandoned"],
)
def test_apply_edited_file_without_progress_runs_from_statement_1(
    tmp_path: Path, operations: list[OperationState]
) -> None:
    client = _RecordingClient()
    store = FakeStore(in_progress(operations, checksum="old"))
    lines: list[str] = []
    _apply(_write(tmp_path, EDITED_SQL), client, store, log=lines.append)
    assert lines == [
        "m.sql changed since its last failed attempt; no statement is recorded as "
        "completed, so it runs again from statement 1."
    ]
    assert client.calls == [
        "ALTER TABLE t ADD COLUMN a UInt64",
        "ALTER TABLE t ADD COLUMN b2 UInt64",
    ]
    assert store.writes[0].checksum == checksum_sql(EDITED_SQL)
    assert store.appended[0].checksum == checksum_sql(EDITED_SQL)


def test_apply_started_statement_still_requires_retry(tmp_path: Path) -> None:
    client = _RecordingClient()
    store = FakeStore(in_progress([op(0, "started")], checksum="old"))
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, EDITED_SQL), client, store)
    assert info.value.code == "in_progress_checksum_mismatch"
    assert client.calls == []


def test_apply_retry_that_fails_again_resumes_without_retry(tmp_path: Path) -> None:
    fail = [True]
    client = _RecordingClient(fail=lambda s: fail[0] and "b2" in s)
    store = FakeStore(in_progress([op(0, "completed"), op(1, "failed")], checksum="old"))
    with pytest.raises(RuntimeError, match="failed at statement 2 of 2"):
        _apply(_write(tmp_path, EDITED_SQL), client, store, retry=_retry_for(EDITED_SQL))
    assert store.state is not None
    assert store.state.checksum == checksum_sql(EDITED_SQL)
    fail[0] = False
    client.calls.clear()
    _apply(tmp_path, client, store)
    assert client.calls == ["ALTER TABLE t ADD COLUMN b2 UInt64"]
    assert len(store.appended) == 1


_MARKER = "-- operation: alter_table_modify_column key=table:db.t:column:f risk=caution\n"
_REMOVE = "ALTER TABLE db.t MODIFY COLUMN `f` REMOVE MATERIALIZED;"
_MODIFY = "ALTER TABLE db.t MODIFY COLUMN `f` DateTime;"


def _remove_failed_state() -> MigrationRowState:
    return in_progress([op(0, "completed", MODIFY_F), op(1, "failed", MODIFY_F)], checksum="old")


def test_apply_retry_refuses_deleted_completed_remove(tmp_path: Path) -> None:
    sql = f"{_MARKER}{_MODIFY}\n"
    client = _RecordingClient()
    store = FakeStore(_remove_failed_state())
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, sql), client, store, retry=_retry_for(sql))
    assert info.value.code == "retry_mismatch"
    assert client.calls == []
    assert store.writes == []
    assert store.appended == []


def test_apply_retry_skips_kept_remove_and_runs_modify(tmp_path: Path) -> None:
    sql = f"{_MARKER}{_REMOVE}\n{_MARKER}{_MODIFY}\n"
    client = _RecordingClient()
    store = FakeStore(_remove_failed_state())
    _apply(_write(tmp_path, sql), client, store, retry=_retry_for(sql))
    # Python keeps the `-- operation:` line in the statement it executes.
    assert len(client.calls) == 1
    assert client.calls[0].endswith(_MODIFY.rstrip(";"))
    assert store.appended[0].checksum == checksum_sql(sql)


def test_apply_retry_checks_statements_returned_by_plugins(tmp_path: Path) -> None:
    sql = (
        "-- operation: alter_table_add_column key=table:default.t risk=safe\n"
        "ALTER TABLE t ADD COLUMN a UInt64;\n"
        "-- operation: alter_table_add_column key=table:default.t2 risk=safe\n"
        "ALTER TABLE t2 ADD COLUMN b UInt64;\n"
    )
    client = _RecordingClient()
    store = FakeStore(
        in_progress(
            [
                op(0, "completed", Marker(type="alter_table_add_column", key="table:default.t")),
                op(1, "completed", Marker(type="alter_table_add_column", key="table:default.t2")),
            ],
            checksum="old",
        )
    )
    # A plugin that drops the first statement shifts every index.
    with pytest.raises(MigrateError) as info:
        _apply(
            _write(tmp_path, sql),
            client,
            store,
            retry=_retry_for(sql),
            runtime=_FakeRuntime(lambda statements: statements[1:]),
        )
    assert info.value.code == "retry_mismatch"
    assert client.calls == []


# ---------- CLI usage errors (no connection needed) ----------

_NO_CLICKHOUSE_CONFIG = """
from chkit import define_config

config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
    }
)
"""


@pytest.fixture
def usage_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(_NO_CLICKHOUSE_CONFIG, encoding="utf-8")
    return tmp_path


@pytest.mark.parametrize(
    ("extra", "flag"),
    [
        (["--retry", "y"], "--retry"),
        (["--table", "app.users"], "--table"),
        (["--allow-destructive"], "--allow-destructive"),
    ],
)
def test_cli_abandon_rejects_conflicting_flags(
    usage_project: Path, extra: list[str], flag: str
) -> None:
    _ = usage_project
    result = CliRunner().invoke(app, ["migrate", "--json", "--abandon", "x", *extra])
    assert result.exit_code == 1
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is False
    assert envelope["command"] == "migrate"
    assert envelope["error"]["code"] == "invalid_usage"
    assert f"--abandon cannot be combined with {flag}" in envelope["error"]["message"]


def test_cli_empty_migration_name_is_usage_error(usage_project: Path) -> None:
    _ = usage_project
    retry = CliRunner().invoke(app, ["migrate", "--json", "--retry="])
    assert retry.exit_code == 1
    assert json.loads(retry.stdout)["error"]["code"] == "invalid_usage"
    assert "--retry requires a migration file name" in json.loads(retry.stdout)["error"]["message"]
    abandon = CliRunner().invoke(app, ["migrate", "--json", "--abandon=chkit/migrations/"])
    assert json.loads(abandon.stdout)["error"]["code"] == "invalid_usage"
    assert "--abandon requires a migration file name" in json.loads(abandon.stdout)["error"]["message"]


def test_cli_abandon_text_mode_prints_usage_error(usage_project: Path) -> None:
    _ = usage_project
    result = CliRunner().invoke(app, ["migrate", "--abandon", "x", "--table", "t"])
    assert result.exit_code == 1
    assert "--abandon cannot be combined with --table" in result.stderr
