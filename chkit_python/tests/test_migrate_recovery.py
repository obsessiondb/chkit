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
from unittest.mock import MagicMock

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
from chkit.cli.commands.migrate_apply import (
    PROPAGATION_WAIT_PENDING,
    ApplyMigrationInput,
    StatementError,
    apply_migration,
)
from chkit.cli.commands.migrate_empty import find_empty_migrations
from chkit.cli.commands.migrate_errors import (
    MigrateError,
    empty_migrations_error,
    in_progress_checksum_mismatch_error,
)
from chkit.cli.commands.migrate_output import format_retry_notice, render_abandon_text
from chkit.cli.commands.migrate_query_intents import QueryContext, QueryTracker
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
    recorded_statement_mismatches,
    resolve_recovery_targets,
    retry_mismatch_error,
    split_changed_statements,
    statement_identities,
    statement_identity,
    verify_retry_edit,
)
from chkit.cli.commands.migrate_retry import RetryNoop, RetryResume, resolve_retry
from chkit.cli.journal_store import EveryCopyRead, MigrationRowState, OperationState
from chkit.cli.main import app
from chkit.cli.migration_store import MigrationJournalEntry, checksum_sql
from chkit.cli.safety_markers import (
    MigrationOperationSummary,
    extract_migration_operation_summaries,
    extract_statement_operations,
)
from chkit.cli.table_scope import TableScope
from chkit.clickhouse.client import QueryResult, QueryStatus
from chkit.core.sql_fingerprint import statement_fingerprint
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
        fingerprint="",
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
    # Whether the journal stores an async attempt's fence (#767).
    fences: bool = True
    reads: list[str] = field(default_factory=list)
    writes: list[MigrationRowState] = field(default_factory=list)
    appended: list[MigrationJournalEntry] = field(default_factory=list)

    def read_migration_state(self, name: str) -> MigrationRowState | None:
        self.reads.append(name)
        return self.state

    def read_stored_operation(self, _name: str, index: int) -> OperationState | None:
        if self.state is None:
            return None
        return next((op for op in self.state.operations if op.operation_index == index), None)

    def stores_attempt_fences(self) -> bool:
        return self.fences

    def read_operation_on_every_copy(self, name: str, index: int) -> EveryCopyRead:
        return EveryCopyRead(covered=True, op=self.read_stored_operation(name, index))

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
    assert len(statement_identities(operations, [None, None], operations)) == 2


def test_verify_retry_edit_accepts_kept_completed_prefix() -> None:
    result = verify_retry_edit(
        [op(0, "completed", A), op(1, "completed", B), op(2, "failed", V)],
        identities(A, B, Marker(type="create_view", key="view:db.w"), V),
    )
    assert result == RetryEditOk(completed=2, unmarked_completed=0, position_only_completed=0, resume_index=2)


def test_verify_retry_edit_rejects_changed_marker() -> None:
    result = verify_retry_edit([op(0, "completed", A), op(1, "failed", V)], identities(B, V))
    assert result == RetryEditMismatch(
        mismatches=[
            OperationMismatch(statement=1, status="completed", query_id="", recorded=A, current=B, sql_changed=False)
        ],
        shared_markers=[],
    )


def test_verify_retry_edit_rejects_missing_statement() -> None:
    result = verify_retry_edit([op(3, "completed", A)], identities(A, B, V))
    assert isinstance(result, RetryEditMismatch)
    assert result.mismatches == [
        OperationMismatch(statement=4, status="completed", query_id="", recorded=A, current=None, sql_changed=False)
    ]


def test_verify_retry_edit_matches_unmarked_statements_by_position() -> None:
    result = verify_retry_edit(
        [op(0, "completed"), op(1, "completed")], statement_identities([], [None, None, None], [])
    )
    assert result == RetryEditOk(completed=2, unmarked_completed=2, position_only_completed=2, resume_index=2)


def test_verify_retry_edit_resume_index_bounds() -> None:
    assert verify_retry_edit([op(0, "failed", A)], identities(B)) == RetryEditOk(
        completed=0, unmarked_completed=0, position_only_completed=0, resume_index=0
    )
    assert verify_retry_edit(
        [op(0, "completed", A), op(1, "completed", B)], identities(A, B)
    ) == RetryEditOk(completed=2, unmarked_completed=0, position_only_completed=0, resume_index=None)


def test_verify_retry_edit_ignores_failed_and_unsubmitted_started() -> None:
    result = verify_retry_edit(
        [op(0, "completed", A), op(1, "failed", V), op(2, "started", B)],
        identities(A, B, V),
    )
    assert result == RetryEditOk(completed=1, unmarked_completed=0, position_only_completed=0, resume_index=1)


def test_verify_retry_edit_rejects_moved_running_async_statement() -> None:
    result = verify_retry_edit(
        [op(0, "completed", A), op(1, "started", LOAD, query_id="q-1")], identities(A, V)
    )
    assert result == RetryEditMismatch(
        mismatches=[
            OperationMismatch(
                statement=2, status="started", query_id="q-1", recorded=LOAD, current=V, sql_changed=False
            )
        ],
        shared_markers=[],
    )
    assert verify_retry_edit(
        [op(1, "started", LOAD, query_id="q-1")], identities(A, LOAD)
    ) == RetryEditOk(completed=0, unmarked_completed=0, position_only_completed=0, resume_index=0)


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
    ok = RetryEditOk(completed=1, unmarked_completed=0, position_only_completed=0, resume_index=1)
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
                statement=2, status="completed", query_id="", recorded=MODIFY_F, current=V, sql_changed=False
            )
        ],
        shared_markers=[],
    )


def test_verify_retry_edit_after_abandon_has_no_shared_check() -> None:
    assert verify_retry_edit(
        [op(0, "failed", MODIFY_F), op(1, "failed", MODIFY_F)], identities(MODIFY_F)
    ) == RetryEditOk(completed=0, unmarked_completed=0, position_only_completed=0, resume_index=0)


# ---------- errors ----------


def test_retry_mismatch_error_names_mismatches_and_kill_query() -> None:
    error = retry_mismatch_error(
        "m.sql",
        RetryEditMismatch(
            mismatches=[
                OperationMismatch(
                    statement=1, status="completed", query_id="", recorded=A, current=B, sql_changed=False
                ),
                OperationMismatch(
                    statement=2, status="started", query_id="q-1", recorded=LOAD, current=None, sql_changed=False
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


# Releases before #831 paired the n-th marker with the n-th statement, and the
# journal names the marker they gave each statement. After an upgrade, a
# --retry of such an in-progress migration still matches those records.
def _order_paired_file(failing: str) -> str:
    return "\n".join(
        [
            "CREATE TABLE db.a (id UInt64) ENGINE = MergeTree ORDER BY id;",
            "-- operation: load_table_data key=table:db.a risk=caution mode=async",
            "INSERT INTO db.a SELECT number FROM numbers(10);",
            failing,
        ]
    )


def _file_identities(sql: str) -> list[StatementIdentity]:
    return statement_identities(
        extract_statement_operations(sql),
        [None for _ in extract_executable_statements(sql)],
        extract_migration_operation_summaries(sql),
    )


# What the earlier release recorded: statement 1 ran as the load, statement 2 unmarked.
_ORDER_PAIRED_RECORDS = [op(0, "completed", LOAD, query_id="q-0"), op(1, "completed"), op(2, "failed")]


def test_order_paired_statements_keep_their_own_markers_now() -> None:
    assert [(i.type, i.key) for i in _file_identities(_order_paired_file("SELECT 2;"))] == [
        ("sql_statement", "statement:0"),
        (LOAD.type, LOAD.key),
        ("sql_statement", "statement:2"),
    ]


def test_retry_accepts_completed_statements_under_the_marker_they_were_recorded_with() -> None:
    result = verify_retry_edit(_ORDER_PAIRED_RECORDS, _file_identities(_order_paired_file("SELECT 2;")))
    assert result == RetryEditOk(
        completed=2, unmarked_completed=1, position_only_completed=1, resume_index=2
    )


def test_retry_refuses_a_recorded_marker_neither_pairing_gives_the_statement() -> None:
    result = verify_retry_edit(
        [op(0, "completed", A)], _file_identities(_order_paired_file("SELECT 2;"))
    )
    assert isinstance(result, RetryEditMismatch)


def test_retry_checks_the_order_pairing_as_a_whole_so_a_shared_marker_keeps_its_count() -> None:
    shared = "-- operation: alter_table_modify_column key=table:db.t:column:f risk=caution"
    # The REMOVE DEFAULT that completed was deleted; only the MODIFY after it is left.
    sql = "\n".join(["SELECT 0;", shared, "ALTER TABLE db.t MODIFY COLUMN f UInt64;"])
    result = verify_retry_edit(
        [op(0, "completed", MODIFY_F), op(1, "completed", MODIFY_F), op(2, "failed", MODIFY_F)],
        _file_identities(sql),
    )
    assert isinstance(result, RetryEditMismatch)


def test_rebase_drops_a_failed_record_only_the_order_pairing_matches() -> None:
    sql = "\n".join(
        [
            "-- operation: load_table_data key=table:db.a risk=caution",
            "-- INSERT INTO db.a SELECT bad;",
            "/* replacement */",
            "-- operation: load_table_data key=table:db.b risk=caution",
            "-- before-retry: TRUNCATE TABLE db.b",
            "INSERT INTO db.b SELECT 1;",
        ]
    )
    state = in_progress([op(0, "failed", LOAD)], checksum="old")
    rebased = rebase_in_progress_state(
        state, checksum="new", identities=_file_identities(sql), applied_at="T"
    )
    assert rebased.operations == []


def test_rebase_keeps_a_failed_attempt_of_the_same_sql_under_the_order_pairing() -> None:
    sql = "\n".join(
        [
            "SELECT 0;",
            "-- operation: load_table_data key=table:db.a risk=caution",
            "-- before-retry: TRUNCATE TABLE db.a",
            "INSERT INTO db.a SELECT number FROM numbers(10);",
            "-- edited",
        ]
    )
    fingerprints = [statement_fingerprint(s) for s in extract_executable_statements(sql)]
    failed = op(1, "failed").model_copy(update={"fingerprint": fingerprints[1]})
    state = in_progress([op(0, "completed", LOAD), failed], checksum="old")
    identities = statement_identities(
        extract_statement_operations(sql), fingerprints, extract_migration_operation_summaries(sql)
    )
    check = verify_retry_edit(state.operations, identities)
    assert isinstance(check, RetryEditOk)
    assert check.resume_index == 1
    rebased = rebase_in_progress_state(state, checksum="new", identities=identities, applied_at="T")
    assert rebased.operations == [op(0, "completed", LOAD), failed]
    # A record of other SQL is another statement's attempt.
    other = failed.model_copy(update={"fingerprint": "other"})
    rebased_other = rebase_in_progress_state(
        state.model_copy(update={"operations": [other]}),
        checksum="new",
        identities=identities,
        applied_at="T",
    )
    assert rebased_other.operations == []


def test_rebase_keeps_a_started_attempt_recorded_under_the_order_pairing() -> None:
    state = in_progress([op(0, "started", LOAD, query_id="q-0")], checksum="old")
    rebased = rebase_in_progress_state(
        state,
        checksum="new",
        identities=_file_identities(_order_paired_file("SELECT 2;")),
        applied_at="T",
    )
    assert rebased.operations == [op(0, "started", LOAD, query_id="q-0")]


@pytest.mark.parametrize("fenced", [True, False])
def test_rebase_in_progress_state_carries_the_attempt_fence_as_read(fenced: bool) -> None:
    """#767 (Codex review of #770): a --retry re-key carries each started
    record's fence as the journal returned it, so it never makes an unfenced
    record trusted, nor drops the fence of one this release wrote."""
    started = op(0, "started", LOAD, query_id="q-0").model_copy(
        update={"attempt_fenced": fenced}
    )
    rebased = rebase_in_progress_state(
        in_progress([started], checksum="old"),
        checksum="new",
        identities=identities(LOAD),
        applied_at="T",
    )
    assert rebased.operations == [started]
    assert rebased.operations[0].attempt_fenced is fenced


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
    plugins_rewrite_statements: bool = False,
) -> RetryNoop | RetryResume:
    return resolve_retry(
        migration="m.sql",
        migrations_dir=migrations_dir,
        pending=["m.sql"] if pending is None else pending,
        empty_migrations=empty or [],
        applied_names=applied or set(),
        journal_store=store,
        plugins_rewrite_statements=plugins_rewrite_statements,
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
        position_only_completed_statements=0,
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
        "positionOnlyCompletedStatements": 0,
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
        table_scope=TableScope(enabled=False),
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
    position_only_completed_statements=0,
)


def test_format_retry_notice() -> None:
    assert format_retry_notice(_RESUME) == [
        "Retry m.sql: the file changed after a failed apply. 1 completed statement(s) "
        "will be skipped; resuming at statement 2 of 3."
    ]
    # Unmarked statements whose fingerprints were checked are not position-only.
    checked = _RESUME.model_copy(update={"unmarked_completed_statements": 1})
    assert len(format_retry_notice(checked)) == 1
    unmarked = format_retry_notice(
        checked.model_copy(update={"position_only_completed_statements": 1})
    )
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
            ["CREATE TABLE t (id UInt64) ENGINE = Memory;"],
        ),
        ("-- header\n/* block; with semicolon */\n-- more\n", []),
        ("SELECT 1;\n/* a */ /* b */;\nSELECT 2;", ["SELECT 1;", "SELECT 2;"]),
        ("# note\n;", []),
        ("#! shebang\n", []),
        ("// note\n;", []),
        ("/* a /* nested */ b */;", []),
        ("SELECT 1;\n// trailing note", ["SELECT 1;"]),
        ("SELECT '/* not a comment */';", ["SELECT '/* not a comment */';"]),
        ("SELECT `/*x*/` FROM t;", ["SELECT `/*x*/` FROM t;"]),
        ("SELECT '# a; b';\n/* end */", ["SELECT '# a; b';"]),
        # `#x` is not a comment (ClickHouse needs `# ` or `#!`).
        ("#x;", ["#x;"]),
        ("SELECT 1;\n/* never closed", ["SELECT 1;", "/* never closed;"]),
        # ClickHouse reads the whole line as one comment, and so does the splitter (#562).
        (
            "// DROP TABLE a; DROP TABLE b;\nSELECT 1;",
            ["// DROP TABLE a; DROP TABLE b;\nSELECT 1;"],
        ),
        ("# old: DROP TABLE a; DROP TABLE b;\n", []),
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

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
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
    query_tracker: QueryTracker | None = None,
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
            query_tracker=query_tracker,
        )
    )


def test_sync_retry_tracks_compensation_and_forward_separately(tmp_path: Path) -> None:
    statement = "INSERT INTO db.a SELECT 1;"
    before_retry = "TRUNCATE TABLE db.a"
    sql = (
        "-- operation: load_table_data key=table:db.a risk=safe mode=sync\n"
        f"-- before-retry: {before_retry}\n{statement}"
    )
    store = FakeStore(in_progress([op(0, "failed", LOAD)], checksum=checksum_sql(sql)))
    client = _RecordingClient()
    tracker = MagicMock()
    phases: list[str] = []

    def command(context: QueryContext, phase: str, text: str, settings: Any) -> None:
        assert context == QueryContext("m.sql", 0, statement, before_retry)
        assert settings is None
        assert store.state is not None
        assert store.state.operations[0].status == ("failed" if phase == "compensation" else "started")
        assert text == (before_retry if phase == "compensation" else statement)
        phases.append(phase)

    tracker.command.side_effect = command
    _apply(_write(tmp_path, sql), client, store, query_tracker=tracker)
    assert phases == ["compensation", "forward"]
    assert client.calls == []
    assert store.state is not None
    assert store.state.migration_completed is True


class _ModeOnlyEditClient(_RecordingClient):
    """Answers the recorded async attempt's check; records the journal at each command."""

    def __init__(self, store: FakeStore, status: QueryStatus) -> None:
        super().__init__()
        self._store = store
        self._status = status
        self.checks: list[tuple[str, str | None, bool]] = []
        self.record_at_command: list[OperationState | None] = []

    def query(self, sql: str, settings: dict[str, Any] | None = None) -> QueryResult:
        _ = settings
        return QueryResult(column_names=["x"], rows=[{"x": 1}] if "system.tables" in sql else [])

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
        include_before_start: bool = False,
    ) -> QueryStatus:
        assert every_replica
        self.checks.append((query_id, after_time, running_only))
        return self._status

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
        state = self._store.state
        self.record_at_command.append(state.operations[0] if state is not None else None)
        super().execute(statement, settings)


def _mode_only_edit(
    tmp_path: Path, status: QueryStatus, *, last_error: str | None = None
) -> tuple[FakeStore, _ModeOnlyEditClient, Callable[[], MigrationJournalEntry], str]:
    """#767 (Codex review of #770, rounds 1 and 2): a mode-only async to sync
    edit with --retry resolves the recorded async attempt before the sync path
    runs anything."""
    statement = "INSERT INTO db.a SELECT 1;"
    original = (
        "-- operation: load_table_data key=table:db.a risk=safe mode=async\n"
        f"-- before-retry: TRUNCATE TABLE db.a\n{statement}\n"
    )
    edited = original.replace("mode=async", "mode=sync")
    attempt = op(0, "started", LOAD, query_id="fenced-query-id").model_copy(
        update={
            "last_error": last_error
            or "submitted under its own query id; a retry reads its outcome from "
            "system.query_log",
            "fingerprint": statement_fingerprint(statement),
            "attempt_fenced": True,
        }
    )
    store = FakeStore(in_progress([attempt], checksum=checksum_sql(original)))
    client = _ModeOnlyEditClient(store, status)
    directory = _write(tmp_path, edited)
    retry = _retry_for(edited, previous=checksum_sql(original))
    return store, client, lambda: _apply(directory, cast(Any, client), store, retry=retry), statement


def test_a_mode_only_edit_records_an_attempt_that_finished_as_completed_and_runs_nothing(
    tmp_path: Path,
) -> None:
    store, client, run, _statement = _mode_only_edit(
        tmp_path, QueryStatus(status="finished", written_rows=1, duration_ms=10)
    )
    run()
    assert client.calls == []
    assert client.checks[0] == ("fenced-query-id", "2026-09-28T23:11:10.000Z", False)
    assert store.state is not None
    assert (store.state.operations[0].status, store.state.operations[0].query_id) == (
        "completed", "fenced-query-id"
    )
    assert store.state.migration_completed is True


def test_a_mode_only_edit_journals_a_server_rejection_before_its_before_retry_sql(
    tmp_path: Path,
) -> None:
    _store, client, run, statement = _mode_only_edit(
        tmp_path,
        QueryStatus(status="failed", error="Code: 60. UNKNOWN_TABLE", before_start=True),
    )
    run()
    assert client.calls == ["TRUNCATE TABLE db.a", statement]
    recorded = client.record_at_command[0]
    assert recorded is not None
    assert (recorded.status, recorded.query_id, recorded.last_error, recorded.attempt_fenced) == (
        "failed", "fenced-query-id", "Code: 60. UNKNOWN_TABLE", True
    )


def test_a_mode_only_edit_stops_with_async_outcome_unknown_without_an_outcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _s: None)
    store, client, run, _statement = _mode_only_edit(tmp_path, QueryStatus(status="unknown"))
    with pytest.raises(MigrateError) as info:
        run()
    assert info.value.code == "async_outcome_unknown"
    assert "query_id fenced-query-id" in info.value.message
    assert client.calls == []
    assert store.writes == []


class _NoOutcomeAsyncClient(_RecordingClient):
    """No replica runs the recorded async attempt; nothing is ever submitted."""

    def query(self, _sql: str) -> QueryResult:
        return QueryResult(
            column_names=["now_ms", "database"],
            rows=[{"now_ms": "1700000000000", "database": "db"}],
        )

    def query_status(
        self, _query_id: str, *, every_replica: bool = False, running_only: bool = False
    ) -> QueryStatus:
        _ = (every_replica, running_only)
        return QueryStatus(status="unknown")

    def submit(self, *_args: Any, **_kwargs: Any) -> str:
        msg = "never submitted"
        raise AssertionError(msg)


def test_an_async_statement_without_a_readable_outcome_keeps_async_outcome_unknown(
    tmp_path: Path,
) -> None:
    """#767: the stop keeps its code through apply_migration's statement
    error, so --json reports async_outcome_unknown."""
    statement = "INSERT INTO db.a SELECT 1;"
    sql = f"-- operation: load_table_data key=table:db.a risk=safe mode=async\n{statement}\n"
    attempt = op(0, "started", LOAD, query_id="legacy-query-id").model_copy(
        update={"fingerprint": statement_fingerprint(statement)}
    )
    store = FakeStore(in_progress([attempt], checksum=checksum_sql(sql)))
    client = _NoOutcomeAsyncClient()
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, sql), cast(Any, client), store)
    assert info.value.code == "async_outcome_unknown"
    assert info.value.message.startswith("Migration m.sql failed at statement 1 of 1")
    assert (
        "query_id legacy-query-id): the journal records an attempt of it"
        in info.value.message
    )
    assert client.calls == []
    assert store.writes == []


class _FailedLookupAsyncClient(_NoOutcomeAsyncClient):
    """The outcome lookup of the recorded async attempt fails."""

    def __init__(self, error: Exception) -> None:
        super().__init__()
        self.error = error

    def query_status(
        self, _query_id: str, **_options: Any
    ) -> QueryStatus:
        raise self.error


@pytest.mark.parametrize(
    ("lookup_error", "text"),
    [
        (
            RuntimeError("HTTP 504: gateway timeout"),
            "could not check whether a previous attempt is still running "
            "(HTTP 504: gateway timeout)",
        ),
        (
            RuntimeError(
                "Code: 497. DB::Exception: default: Not enough privileges. To execute "
                "this query, it's necessary to have the grant SELECT(type, query_id) ON "
                "system.query_log. (ACCESS_DENIED)"
            ),
            "the ClickHouse user cannot read system.query_log",
        ),
    ],
    ids=["a gateway error", "denied system.query_log access"],
)
def test_an_async_statement_whose_fenced_attempt_lookup_fails_keeps_async_outcome_unknown(
    tmp_path: Path, lookup_error: Exception, text: str
) -> None:
    """A lookup of a fenced attempt's outcome that fails leaves the outcome
    unknown, so --json reports async_outcome_unknown, with the request's error
    as the cause."""
    statement = "INSERT INTO db.a SELECT 1;"
    sql = f"-- operation: load_table_data key=table:db.a risk=safe mode=async\n{statement}\n"
    attempt = op(0, "started", LOAD, query_id="fenced-query-id").model_copy(
        update={
            "last_error": "submitted under its own query id; a retry reads its outcome from "
            "system.query_log",
            "fingerprint": statement_fingerprint(statement),
            "attempt_fenced": True,
        }
    )
    store = FakeStore(in_progress([attempt], checksum=checksum_sql(sql)))
    client = _FailedLookupAsyncClient(lookup_error)
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, sql), cast(Any, client), store)
    assert info.value.code == "async_outcome_unknown"
    assert info.value.message.startswith("Migration m.sql failed at statement 1 of 1")
    assert f"(query_id fenced-query-id): {text}" in info.value.message
    # The stop's own error, then the request's.
    stop = info.value.__cause__
    assert isinstance(stop, MigrateError)
    assert stop.code == "async_outcome_unknown"
    assert stop.__cause__ is lookup_error
    assert client.calls == []
    assert store.writes == []


def _retry_for(sql: str, previous: str = "old") -> RetryResume:
    return RetryResume(
        migration="m.sql",
        previous_checksum=previous,
        checksum=checksum_sql(sql),
        total_statements=0,
        completed_statements=0,
        resume_at_statement=None,
        unmarked_completed_statements=0,
        position_only_completed_statements=0,
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
    assert "boom: ALTER TABLE t ADD COLUMN b UInt64;" in str(info.value)
    assert client.calls == ["ALTER TABLE t ADD COLUMN a UInt64;", "ALTER TABLE t ADD COLUMN b UInt64;"]
    assert store.state is not None
    assert [(o.operation_index, o.status) for o in store.state.operations] == [
        (0, "completed"),
        (1, "failed"),
    ]
    assert store.appended == []

    fail_b[0] = False
    client.calls.clear()
    _apply(tmp_path, client, store)
    assert client.calls == ["ALTER TABLE t ADD COLUMN b UInt64;"]
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

    store = _OrderStore()
    _apply(_write(tmp_path, sql), client, store)
    # The second write clears the pending-wait marker once the wait passed (#513).
    assert client.events == ["command", "completed-write", "propagation-query", "completed-write"]
    assert store.state is not None
    assert store.state.operations[0].last_error == ""


# ---------- resume after a propagation wait timeout (#513) ----------

_CREATE_T = "CREATE TABLE IF NOT EXISTS default.t (id UInt64) ENGINE = MergeTree ORDER BY id"
_INSERT_T = "INSERT INTO default.t VALUES (1)"
_CREATE_MARKER = "-- operation: create_table key=table:default.t risk=safe\n"
_WAIT_SQL = f"{_CREATE_MARKER}{_CREATE_T};\n{_INSERT_T};\n"
# The statement as sent: comments stripped and the `;` kept, as in TS (#486).
_CREATE_SENT = f"{_CREATE_T};"


class _PropagationClient:
    """A single-replica target on which default.t is listed in system.tables
    only while ``visible`` is set."""

    def __init__(self, events: list[str], *, visible: bool) -> None:
        self.events = events
        self.visible = visible

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
        self.events.append(f"command {statement}")

    def query(self, _sql: str) -> QueryResult:
        self.events.append("propagation-query")
        return QueryResult(column_names=["x"], rows=[{"x": 1}] if self.visible else [])


class _EventStore(FakeStore):
    def __init__(self, events: list[str], state: MigrationRowState | None = None) -> None:
        super().__init__(state)
        self.events = events

    def append_entry(self, entry: MigrationJournalEntry, *, chkit_version: str) -> None:
        self.events.append("append")
        super().append_entry(entry, chkit_version=chkit_version)


@pytest.mark.usefixtures("propagation_clock")
def test_apply_waits_again_for_completed_statement_after_wait_timeout(tmp_path: Path) -> None:
    events: list[str] = []
    client = _PropagationClient(events, visible=False)
    store = _EventStore(events)
    _write(tmp_path, _WAIT_SQL)

    with pytest.raises(RuntimeError, match=r"waitForTable: default\.t not yet visible"):
        _apply(tmp_path, cast(Any, client), store)
    assert events[0] == f"command {_CREATE_SENT}"
    assert [e for e in events if e.startswith("command")] == [f"command {_CREATE_SENT}"]
    assert store.state is not None
    assert [(o.operation_index, o.status, o.last_error) for o in store.state.operations] == [
        (0, "completed", PROPAGATION_WAIT_PENDING)
    ]
    assert store.appended == []

    client.visible = True
    events.clear()
    _apply(tmp_path, cast(Any, client), store)
    assert events == ["propagation-query", f"command {_INSERT_T};", "append"]
    assert [(o.operation_index, o.status, o.last_error) for o in store.state.operations] == [
        (0, "completed", ""),
        (1, "completed", ""),
    ]
    assert [(e.name, e.checksum) for e in store.appended] == [("m.sql", checksum_sql(_WAIT_SQL))]


@pytest.mark.usefixtures("propagation_clock")
def test_apply_waits_again_after_abandon_restart_with_later_record(tmp_path: Path) -> None:
    # --abandon keeps every record as failed, so the next run restarts at
    # statement 1 with the abandoned record of statement 2 still in the state.
    def abandoned(index: int, was: str, marker: Marker | None = None) -> OperationState:
        return op(
            index, "failed", marker, last_error=f"abandoned via chkit migrate --abandon (was {was})"
        )

    events: list[str] = []
    client = _PropagationClient(events, visible=False)
    store = _EventStore(
        events,
        in_progress(
            [
                abandoned(0, "completed", Marker(type="create_table", key="table:default.t")),
                abandoned(1, "failed"),
            ],
            checksum=checksum_sql(_WAIT_SQL),
        ),
    )
    _write(tmp_path, _WAIT_SQL)

    with pytest.raises(RuntimeError, match=r"waitForTable: default\.t not yet visible"):
        _apply(tmp_path, cast(Any, client), store)
    assert [e for e in events if e.startswith("command")] == [f"command {_CREATE_SENT}"]

    client.visible = True
    events.clear()
    _apply(tmp_path, cast(Any, client), store)
    assert events == ["propagation-query", f"command {_INSERT_T};", "append"]


@pytest.mark.usefixtures("propagation_clock")
def test_apply_does_not_record_when_wait_times_out_again(tmp_path: Path) -> None:
    events: list[str] = []
    client = _PropagationClient(events, visible=False)
    store = _EventStore(events)
    _write(tmp_path, _WAIT_SQL)

    with pytest.raises(RuntimeError, match=r"waitForTable: default\.t not yet visible"):
        _apply(tmp_path, cast(Any, client), store)
    writes_after_first_run = len(store.writes)
    events.clear()
    with pytest.raises(RuntimeError, match=r"waitForTable: default\.t not yet visible"):
        _apply(tmp_path, cast(Any, client), store)

    assert len(events) > 1
    assert all(e == "propagation-query" for e in events)
    assert len(store.writes) == writes_after_first_run
    assert store.state is not None
    assert store.state.migration_completed is False
    assert [(o.operation_index, o.status) for o in store.state.operations] == [(0, "completed")]
    assert store.appended == []


@pytest.mark.usefixtures("propagation_clock")
def test_apply_does_not_wait_again_for_completed_statement_whose_wait_passed(
    tmp_path: Path,
) -> None:
    # A completed statement whose wait passed is not waited for again, even
    # when no later statement is recorded (--retry drops the record of an
    # edited statement). Here a DROP that ran before its acknowledgement was
    # lost removed what the CREATE's wait looks for: that wait could never pass.
    drop = (
        "-- operation: drop_table key=table:default.t risk=danger\nDROP TABLE IF EXISTS default.t"
    )
    sql = f"{_CREATE_MARKER}{_CREATE_T};\n{drop};\n"
    events: list[str] = []
    store = _EventStore(
        events,
        in_progress(
            [
                op(0, "completed", Marker(type="create_table", key="table:default.t")),
            ],
            checksum=checksum_sql(sql),
        ),
    )

    _apply(_write(tmp_path, sql), cast(Any, _PropagationClient(events, visible=False)), store)
    assert events == ["command DROP TABLE IF EXISTS default.t;", "propagation-query", "append"]


# ---------- a SELECT barrier has no propagation wait ----------


class _TwoReplicaClient:
    """A two-replica target where no INSERT is running; every other read (a
    propagation wait) is recorded."""

    def __init__(self) -> None:
        self.events: list[str] = []

    def execute(self, statement: str, settings: dict[str, Any] | None = None) -> None:
        self.events.append(f"command {statement}")

    def query(self, sql: str, settings: dict[str, Any] | None = None) -> QueryResult:
        self.events.append("barrier read" if "system.processes" in sql else f"query {sql}")
        return QueryResult(column_names=[], rows=[])


@pytest.fixture
def _two_replicas(single_replica: None, monkeypatch: pytest.MonkeyPatch) -> None:
    # Depends on the module's single_replica pin so that it runs first and
    # this fanout replaces it.
    from chkit.clickhouse.replicas import ReplicaFanout  # noqa: PLC0415

    fanout = ReplicaFanout(cluster="default", replicas=2)
    for target in (
        "chkit.clickhouse.ddl_propagation.resolve_replica_fanout",
        "chkit.clickhouse.insert_barrier.resolve_replica_fanout",
    ):
        monkeypatch.setattr(target, lambda *_: fanout)


@pytest.mark.usefixtures("_two_replicas")
def test_apply_select_barrier_has_no_propagation_wait(tmp_path: Path) -> None:
    sql = (
        "-- operation: cutover_wait_for_inserts key=table:default.a:cutover:mirror_barrier "
        "risk=safe mode=barrier\n"
        "SELECT query_id FROM system.processes WHERE query_kind = 'Insert';\n"
    )
    client = _TwoReplicaClient()
    store = FakeStore()
    _apply(_write(tmp_path, sql), cast(Any, client), store)
    assert client.events == ["barrier read"]
    assert [(o.status, o.last_error) for state in store.writes for o in state.operations] == [
        ("started", ""),
        ("completed", ""),
    ]
    assert len(store.appended) == 1


@pytest.mark.usefixtures("_two_replicas")
def test_apply_refuses_a_barrier_a_plugin_rewrote(tmp_path: Path) -> None:
    sql = (
        "-- operation: exchange_tables key=table:default.a risk=caution mode=barrier\n"
        "SELECT query_id FROM system.processes WHERE query_kind = 'Insert';\n"
        "-- operation: drop_table key=table:default.b risk=danger\n"
        "DROP TABLE IF EXISTS default.b SYNC;\n"
    )
    client = _TwoReplicaClient()
    store = FakeStore()
    rewrite = _FakeRuntime(
        lambda statements: ["EXCHANGE TABLES default.a AND default.b;", *statements[1:]]
    )
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, sql), cast(Any, client), store, runtime=rewrite)
    assert info.value.code == "barrier_not_select"
    assert (
        "  - m.sql, statement 1 of 2 (-- operation: exchange_tables key=table:default.a "
        "risk=caution mode=barrier):\n"
        "      EXCHANGE TABLES default.a AND default.b;"
    ) in info.value.message
    assert client.events == []
    assert store.writes == []
    assert store.appended == []


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
    assert client.calls == ["ALTER TABLE t ADD COLUMN b2 UInt64;"]
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
        "ALTER TABLE t ADD COLUMN a UInt64;",
        "ALTER TABLE t ADD COLUMN b2 UInt64;",
    ]
    assert store.writes[0].checksum == checksum_sql(EDITED_SQL)
    assert store.appended[0].checksum == checksum_sql(EDITED_SQL)


class _StatusClient(_RecordingClient):
    """Answers the in-flight check of a dropped async attempt."""

    def __init__(self, running: bool | Exception) -> None:
        super().__init__()
        self._running = running
        self.status_calls: list[tuple[str, bool, bool]] = []

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
        include_before_start: bool = False,
    ) -> QueryStatus:
        self.status_calls.append((query_id, every_replica, running_only))
        if isinstance(self._running, Exception):
            raise self._running
        return QueryStatus(status="running" if self._running else "unknown")


@pytest.mark.parametrize("running", [True, False], ids=["running", "stopped"])
def test_apply_edit_dropping_an_async_attempt_checks_it_stopped(
    tmp_path: Path, running: bool
) -> None:
    """#701: an async retry runs under a random query id, so a record the edit
    drops is the only trace of an attempt that may still run (a submit that
    failed while the server ran it). The edit stops while it runs."""
    client = _StatusClient(running)
    store = FakeStore(
        in_progress(
            [
                op(0, "failed"),
                # A rejection the server recorded for the id (#767).
                op(
                    1,
                    "failed",
                    Marker(type="load_table_data", key="table:t"),
                    query_id="retry-query-id",
                ).model_copy(update={"attempt_fenced": True}),
            ],
            checksum="old",
        )
    )
    if running:
        with pytest.raises(MigrateError) as raised:
            _apply(_write(tmp_path, EDITED_SQL), client, store)
        assert raised.value.code == "retry_mismatch"
        assert "KILL QUERY WHERE query_id = 'retry-query-id'" in raised.value.message
    else:
        _apply(_write(tmp_path, EDITED_SQL), client, store)
    assert client.status_calls == [("retry-query-id", True, True)]
    assert len(client.calls) == (0 if running else 2)
    assert (len(store.writes) > 0) is not running


@pytest.mark.parametrize("mode", ["sync", "barrier"])
@pytest.mark.parametrize(
    "prior",
    ["started", "failed", "abandoned", "stopped", "unverified", "unreadable", "no-before-retry"],
)
def test_mode_only_edit_preserves_async_attempt_until_stopped(
    tmp_path: Path, mode: str, prior: str
) -> None:
    sql = (
        "SELECT query_id FROM system.processes WHERE 0;"
        if mode == "barrier" else "INSERT INTO db.a SELECT 1;"
    )
    compensation = "" if prior == "no-before-retry" else "-- before-retry: TRUNCATE TABLE db.a\n"
    original = (
        "-- operation: load_table_data key=table:db.a risk=safe mode=async\n"
        f"{compensation}{sql}\n"
    )
    edited = original.replace("mode=async", f"mode={mode}")
    recorded = in_progress(
        [op(
            0, "failed" if prior in {"failed", "stopped", "unverified", "unreadable"} else "started",
            LOAD, query_id="random-retry-query-id",
        ).model_copy(
            update={
                "fingerprint": statement_fingerprint(sql),
                # A failure the server recorded for the id (#767); 'unverified'
                # is a failed record without one, as an earlier release wrote.
                "attempt_fenced": prior != "unverified",
            }
        )],
        checksum=checksum_sql(original),
    )

    class CrashStore(FakeStore):
        def write_migration_state(self, state: MigrationRowState) -> None:
            super().write_migration_state(state)
            if prior != "stopped" and state.operations[0].query_id == "":
                raise RuntimeError("crash after ID overwrite")

    class ModeClient(_StatusClient):
        def query(self, sql: str, settings: dict[str, Any] | None = None) -> QueryResult:
            return QueryResult(column_names=["query_id"], rows=[{"x": 1}] if "system.tables" in sql else [])

    store = CrashStore(recorded)
    if prior == "abandoned":
        abandon_migration_state(recorded, journal_store=store)
    client = ModeClient(
        RuntimeError("replica unavailable")
        if prior == "unreadable"
        else prior not in {"stopped", "unverified"}
    )
    _write(tmp_path, edited)
    retry = _retry_for(edited, checksum_sql(original))
    if prior == "stopped":
        _apply(tmp_path, client, store, retry=retry)
        assert client.calls == (["TRUNCATE TABLE db.a", sql] if mode == "sync" else ["TRUNCATE TABLE db.a"])
        assert store.state is not None
        assert store.state.migration_completed is True
    elif prior == "unverified":
        # #767 (round 2): it may have finished, so nothing is written or run.
        with pytest.raises(MigrateError) as unknown:
            _apply(tmp_path, client, store, retry=retry)
        assert unknown.value.code == "async_outcome_unknown"
        assert client.calls == []
        assert store.writes == []
    else:
        if prior == "unreadable":
            with pytest.raises(RuntimeError, match="replica unavailable"):
                _apply(tmp_path, client, store, retry=retry)
        else:
            with pytest.raises(MigrateError) as raised:
                _apply(tmp_path, client, store, retry=retry)
            assert raised.value.code == "retry_mismatch"
        assert client.calls == []
        assert store.appended == []
        assert store.state is not None
        assert store.state.operations[0].query_id == "random-retry-query-id"
        assert all(write.operations[0].query_id == "random-retry-query-id" for write in store.writes)
    # A fenced started attempt is also read from query_log (#767). An attempt
    # that ended is read before the re-key and again before the statement runs.
    check = ("random-retry-query-id", True, prior not in {"started", "no-before-retry"})
    assert client.status_calls == ([check, check] if prior == "stopped" else [check])


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
    assert client.calls == ["ALTER TABLE t ADD COLUMN b2 UInt64;"]
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
    assert client.calls == [_MODIFY]
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


# ---------- apply_migration with a state another release split differently (#562) ----------

# Releases before #562 cut at a `;` inside a `//` comment: this file was
# [a, DROP z, b, c] for them, and is [a…b, c] now.
SPLIT_SQL = (
    "ALTER TABLE t ADD COLUMN a UInt64 // keep; ALTER TABLE t DROP COLUMN z;\n"
    "ALTER TABLE t ADD COLUMN b UInt64;\n"
    "ALTER TABLE t ADD COLUMN c UInt64;\n"
)


def test_apply_refuses_a_state_whose_recorded_statements_changed_split(tmp_path: Path) -> None:
    client = _RecordingClient()
    # The old release ran a and DROP z, then b failed. Resuming by position
    # would skip c, which never ran.
    store = FakeStore(
        state=in_progress(
            [op(0, "completed"), op(1, "completed"), op(2, "failed")],
            checksum=checksum_sql(SPLIT_SQL),
        )
    )
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, SPLIT_SQL), client, store)
    assert info.value.code == "statement_split_changed"
    message = str(info.value)
    assert message.startswith(
        "Cannot resume m.sql: chkit 0.2.0-test recorded its partial run, and this chkit "
        "(0.0.0-test) splits the file into different statements."
    )
    assert "The journal recorded statements 1, 2 as completed or started" in message
    assert "chkit migrate --apply --abandon m.sql" in message
    assert client.calls == []
    assert store.writes == []
    assert store.appended == []


def test_apply_refuses_a_started_statement_and_names_a_state_without_a_release(
    tmp_path: Path,
) -> None:
    client = _RecordingClient()
    state = in_progress(
        [op(0, "completed"), op(1, "started")], checksum=checksum_sql(SPLIT_SQL)
    ).model_copy(update={"chkit_version": ""})
    store = FakeStore(state=state)
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, SPLIT_SQL), client, store)
    message = str(info.value)
    assert message.startswith(
        "Cannot resume m.sql: an earlier chkit release recorded its partial run"
    )
    assert "The journal recorded statements 1, 2 as completed or started" in message
    assert client.calls == []


def test_apply_resumes_a_state_this_release_recorded(tmp_path: Path) -> None:
    client = _RecordingClient()
    state = in_progress(
        [op(0, "completed"), op(1, "failed")], checksum=checksum_sql(SPLIT_SQL)
    ).model_copy(update={"chkit_version": "0.0.0-test"})
    store = FakeStore(state=state)
    _apply(_write(tmp_path, SPLIT_SQL), client, store)
    assert client.calls == ["ALTER TABLE t ADD COLUMN c UInt64;"]
    assert len(store.appended) == 1


def test_apply_resumes_when_recorded_statements_are_the_same_in_both_splits(
    tmp_path: Path,
) -> None:
    sql = (
        "ALTER TABLE t ADD COLUMN a UInt64;\n"
        "ALTER TABLE t ADD COLUMN b UInt64;\n"
        "ALTER TABLE t ADD COLUMN c UInt64 // keep; ALTER TABLE t DROP COLUMN z;\n"
        "ALTER TABLE t ADD COLUMN d UInt64;\n"
    )
    client = _RecordingClient()
    store = FakeStore(
        state=in_progress([op(0, "completed"), op(1, "failed")], checksum=checksum_sql(sql))
    )
    _apply(_write(tmp_path, sql), client, store)
    assert client.calls == [
        "ALTER TABLE t ADD COLUMN b UInt64;",
        "ALTER TABLE t ADD COLUMN c UInt64 // keep; ALTER TABLE t DROP COLUMN z;\n"
        "ALTER TABLE t ADD COLUMN d UInt64;",
    ]
    assert len(store.appended) == 1


def test_apply_runs_an_abandoned_state_from_statement_1(tmp_path: Path) -> None:
    client = _RecordingClient()
    store = FakeStore(
        state=in_progress(
            [
                op(0, "failed", last_error="abandoned via chkit migrate --abandon (was completed)"),
                op(1, "failed", last_error="abandoned via chkit migrate --abandon (was completed)"),
                op(2, "failed", last_error="abandoned via chkit migrate --abandon (was failed)"),
            ],
            checksum=checksum_sql(SPLIT_SQL),
        )
    )
    _apply(_write(tmp_path, SPLIT_SQL), client, store)
    assert client.calls == [
        "ALTER TABLE t ADD COLUMN a UInt64 // keep; ALTER TABLE t DROP COLUMN z;\n"
        "ALTER TABLE t ADD COLUMN b UInt64;",
        "ALTER TABLE t ADD COLUMN c UInt64;",
    ]
    assert len(store.appended) == 1


def test_apply_refuses_when_on_before_apply_removed_statements_of_a_file_the_splits_differ_on(
    tmp_path: Path,
) -> None:
    """The journal indexes the statements on_before_apply returns: once a
    plugin removes one, the old and new positions cannot be matched."""
    sql = f"SET allow_experimental_x = 1;\n{SPLIT_SQL}"
    client = _RecordingClient()
    store = FakeStore(state=in_progress([op(0, "completed")], checksum=checksum_sql(sql)))
    runtime = _FakeRuntime(lambda statements: [s for s in statements if not s.startswith("SET ")])
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, sql), client, store, runtime=runtime)
    assert info.value.code == "statement_split_changed"
    assert "The journal recorded statement 1 as completed or started, which is not" in str(
        info.value
    )
    assert client.calls == []


def test_apply_refuses_when_on_before_apply_moved_statements_without_changing_their_count(
    tmp_path: Path,
) -> None:
    sql = f"SET allow_experimental_x = 1;\n{SPLIT_SQL}"
    client = _RecordingClient()
    store = FakeStore(state=in_progress([op(0, "completed")], checksum=checksum_sql(sql)))
    runtime = _FakeRuntime(lambda statements: [statements[1], statements[0], *statements[2:]])
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, sql), client, store, runtime=runtime)
    assert info.value.code == "statement_split_changed"
    assert client.calls == []


# ---------- statement fingerprints (#599) ----------
# A record with a fingerprint is matched by its SQL too.


def _with_fingerprint(record: OperationState, fingerprint: str) -> OperationState:
    return record.model_copy(update={"fingerprint": fingerprint})


def _current(marker: Marker, fingerprint: str | None) -> StatementIdentity:
    return StatementIdentity(
        type=marker.type, key=marker.key, marked=True, fingerprint=fingerprint
    )


def test_verify_retry_edit_accepts_a_completed_statement_with_the_same_sql() -> None:
    result = verify_retry_edit(
        [_with_fingerprint(op(0, "completed", A), "v1:a")],
        [_current(A, "v1:a"), _current(B, "v1:b")],
    )
    assert result == RetryEditOk(completed=1, unmarked_completed=0, position_only_completed=0, resume_index=1)


def test_verify_retry_edit_rejects_a_completed_statement_whose_sql_changed() -> None:
    result = verify_retry_edit(
        [_with_fingerprint(op(0, "completed", A), "v1:a")], [_current(A, "v1:x")]
    )
    assert result == RetryEditMismatch(
        mismatches=[
            OperationMismatch(
                statement=1,
                status="completed",
                query_id="",
                recorded=A,
                current=A,
                sql_changed=True,
            )
        ],
        shared_markers=[],
    )


def test_verify_retry_edit_rejects_a_running_async_statement_whose_sql_changed() -> None:
    result = verify_retry_edit(
        [_with_fingerprint(op(0, "started", LOAD, query_id="q-1"), "v1:a")],
        [_current(LOAD, "v1:x")],
    )
    assert isinstance(result, RetryEditMismatch)
    assert [mismatch.sql_changed for mismatch in result.mismatches] == [True]


def test_verify_retry_edit_does_not_check_a_failed_statement() -> None:
    result = verify_retry_edit(
        [_with_fingerprint(op(0, "failed", A), "v1:a")], [_current(A, "v1:x")]
    )
    assert result == RetryEditOk(completed=0, unmarked_completed=0, position_only_completed=0, resume_index=0)


def test_verify_retry_edit_matches_by_marker_only_without_a_fingerprint() -> None:
    assert verify_retry_edit([op(0, "completed", A)], [_current(A, "v1:x")]).ok
    assert verify_retry_edit(
        [_with_fingerprint(op(0, "completed", A), "v1:a")], [_current(A, None)]
    ).ok


def test_verify_retry_edit_counts_as_position_only_just_statements_without_a_fingerprint() -> None:
    s0 = Marker(type="sql_statement", key="statement:0")
    s1 = Marker(type="sql_statement", key="statement:1")
    s2 = Marker(type="sql_statement", key="statement:2")

    def unmarked(marker: Marker, fingerprint: str | None) -> StatementIdentity:
        return StatementIdentity(
            type=marker.type, key=marker.key, marked=False, fingerprint=fingerprint
        )

    mixed = [
        _with_fingerprint(op(0, "completed", s0), "v1:a"),
        op(1, "completed", s1),
        _with_fingerprint(op(2, "completed", s2), "v1:c"),
    ]
    expected = RetryEditOk(
        completed=3, unmarked_completed=3, position_only_completed=1, resume_index=None
    )
    # Every unmarked completed statement still counts in unmarked_completed.
    assert (
        verify_retry_edit(mixed, [unmarked(s0, "v1:a"), unmarked(s1, "v1:b"), unmarked(s2, "v1:c")])
        == expected
    )
    # A check deferred until plugins rewrite the statements still checks the
    # recorded fingerprints.
    assert (
        verify_retry_edit(mixed, [unmarked(s0, None), unmarked(s1, None), unmarked(s2, None)])
        == expected
    )


def test_recorded_statement_mismatches_lists_completed_and_running_async_statements() -> None:
    operations = [
        _with_fingerprint(op(3, "completed", B), "v1:b"),
        _with_fingerprint(op(0, "completed", A), "v1:a"),
        _with_fingerprint(op(1, "started", LOAD, query_id="q-1"), "v1:load"),
        _with_fingerprint(op(2, "failed", V), "v1:v"),
        _with_fingerprint(op(4, "started", V), "v1:sync"),
        op(5, "completed", A),
    ]
    assert recorded_statement_mismatches(
        operations, ["v1:x", "v1:y", "v1:z", "v1:b", "v1:w", "v1:a"]
    ) == [1, 2]


def test_recorded_statement_mismatches_empty_when_every_fingerprint_matches() -> None:
    operations = [_with_fingerprint(op(0, "completed", A), "v1:a")]
    assert recorded_statement_mismatches(operations, ["v1:a"]) == []


def test_recorded_statement_mismatches_statement_past_the_end_of_the_file() -> None:
    operations = [_with_fingerprint(op(2, "completed", A), "v1:a")]
    assert recorded_statement_mismatches(operations, ["v1:a"]) == [3]


def test_split_changed_statements_leaves_fingerprinted_statements_out() -> None:
    operations = [_with_fingerprint(op(0, "completed", A), "v1:a"), op(1, "completed", B)]
    assert split_changed_statements(
        operations, legacy=["a;", "x;", "b;"], current=["a; x;", "b;"], positions_kept=True
    ) == [2]


def test_resolve_retry_with_fingerprints(retry_dir: Path) -> None:
    """The first statement of RETRY_SQL is kept; only its recorded SQL varies."""
    first = extract_executable_statements(RETRY_SQL)[0]
    marker = statement_identity(extract_migration_operation_summaries(RETRY_SQL), 0)
    recorded = Marker(type=marker.type, key=marker.key)

    def state_with(sql: str) -> FakeStore:
        return FakeStore(
            in_progress(
                [_with_fingerprint(op(0, "completed", recorded), statement_fingerprint(sql))],
                checksum="old",
            )
        )

    spaced = first.replace(" ", "  /* c */ ", 1)
    changed = f"{first[:-1]} -- x\n, 1;"
    assert isinstance(_resolve(retry_dir, state_with(spaced)), RetryResume)
    with pytest.raises(MigrateError) as info:
        _resolve(retry_dir, state_with(changed))
    assert info.value.code == "retry_mismatch"
    assert (
        f"statement 1: completed as {recorded.type} {recorded.key}, but the edited file has "
        "different SQL there"
    ) in str(info.value)
    # A plugin may rewrite the statements: apply checks them instead.
    resumed = _resolve(retry_dir, state_with(changed), plugins_rewrite_statements=True)
    assert isinstance(resumed, RetryResume)


@pytest.mark.parametrize("plugins_rewrite_statements", [False, True])
def test_resolve_retry_counts_as_position_only_unmarked_statements_without_a_fingerprint(
    tmp_path: Path, *, plugins_rewrite_statements: bool
) -> None:
    """A journal a no-ALTER run continued: statement 1 has a fingerprint, 2 not."""
    unmarked = [
        "CREATE TABLE db.a (id UInt64) ENGINE = MergeTree ORDER BY id;",
        "CREATE TABLE db.b (id UInt64) ENGINE = MergeTree ORDER BY id;",
        "CREATE TABLE db.c (id UInt64) ENGINE = MergeTree ORDER BY id;",
    ]
    (tmp_path / "m.sql").write_text("\n".join(unmarked), encoding="utf-8")
    store = FakeStore(
        in_progress(
            [
                _with_fingerprint(
                    op(0, "completed", Marker(type="sql_statement", key="statement:0")),
                    statement_fingerprint(unmarked[0]),
                ),
                op(1, "completed", Marker(type="sql_statement", key="statement:1")),
                op(2, "failed", Marker(type="sql_statement", key="statement:2")),
            ],
            checksum="old",
        )
    )
    resumed = _resolve(tmp_path, store, plugins_rewrite_statements=plugins_rewrite_statements)
    assert isinstance(resumed, RetryResume)
    assert resumed.completed_statements == 2
    assert resumed.unmarked_completed_statements == 2
    assert resumed.position_only_completed_statements == 1


_FP_A = "CREATE TABLE p_a (id UInt64) ENGINE = MergeTree ORDER BY id;"
_FP_B = "CREATE TABLE p_b (id UInt64) ENGINE = MergeTree ORDER BY id;"
_FP_C_BROKEN = "CREATE TABLE p_c (id UInt64) ENGINE = MergeTree ORDER BY missing_col;"
_FP_C = "CREATE TABLE p_c (id UInt64) ENGINE = MergeTree ORDER BY id;"
_FP_D = "CREATE TABLE p_d (id UInt64) ENGINE = MergeTree ORDER BY id;"
_FP_ORIGINAL = "\n".join([_FP_A, _FP_B, _FP_C_BROKEN, _FP_D])


def _failed_fingerprint_run(tmp_path: Path) -> MigrationRowState:
    """Run _FP_ORIGINAL until statement 3 fails; the recorded state."""
    run_dir = tmp_path / "first"
    run_dir.mkdir()
    store = FakeStore()
    with pytest.raises(StatementError, match="failed at statement 3 of 4"):
        _apply(
            _write(run_dir, _FP_ORIGINAL),
            _RecordingClient(fail=lambda s: "missing_col" in s),
            store,
        )
    assert store.state is not None
    return store.state


def test_apply_records_the_fingerprint_of_the_statement_with_every_write(
    tmp_path: Path,
) -> None:
    recorded = _failed_fingerprint_run(tmp_path)
    assert [(o.operation_index, o.status, o.fingerprint) for o in recorded.operations] == [
        (0, "completed", statement_fingerprint(_FP_A)),
        (1, "completed", statement_fingerprint(_FP_B)),
        (2, "failed", statement_fingerprint(_FP_C_BROKEN)),
    ]


def test_apply_retry_after_comment_only_edit_runs_the_statements_that_never_ran(
    tmp_path: Path,
) -> None:
    recorded = _failed_fingerprint_run(tmp_path)
    edited = "\n\n".join(
        [
            "-- created first\n" + _FP_A.replace("ENGINE", "/* the engine */ ENGINE"),
            "  " + _FP_B.replace(";", " // b; with a semicolon\n;"),
            _FP_C,
            _FP_D,
        ]
    )
    client = _RecordingClient()
    store = FakeStore(recorded)
    _apply(_write(tmp_path, edited), client, store, retry=_retry_for(edited, recorded.checksum))
    assert client.calls == [_FP_C, _FP_D]
    assert len(store.appended) == 1
    assert store.state is not None
    assert [o.fingerprint for o in store.state.operations] == [
        statement_fingerprint(sql) for sql in (_FP_A, _FP_B, _FP_C, _FP_D)
    ]


def test_apply_retry_refuses_an_edit_that_changed_the_sql_of_a_completed_statement(
    tmp_path: Path,
) -> None:
    recorded = _failed_fingerprint_run(tmp_path)
    # The completed statement 2 (p_b) was removed and p_c fixed: by position
    # the fixed statement would be skipped as completed.
    edited = "\n".join([_FP_A, _FP_C, _FP_D])
    client = _RecordingClient()
    store = FakeStore(recorded)
    with pytest.raises(MigrateError) as info:
        _apply(
            _write(tmp_path, edited), client, store, retry=_retry_for(edited, recorded.checksum)
        )
    assert info.value.code == "retry_mismatch"
    message = str(info.value)
    assert (
        "statement 2: completed as sql_statement statement:1, but the edited file has "
        "different SQL there"
    ) in message
    assert (
        "must keep their position, operation marker and SQL (comments and whitespace may change)"
    ) in message
    assert client.calls == []
    assert store.writes == []
    assert store.appended == []


def test_apply_resumes_a_state_without_fingerprints_by_position_and_marker(
    tmp_path: Path,
) -> None:
    recorded = _failed_fingerprint_run(tmp_path)
    legacy = recorded.model_copy(
        update={
            "operations": [o.model_copy(update={"fingerprint": ""}) for o in recorded.operations]
        }
    )
    edited = "\n".join([_FP_A, _FP_C, _FP_D])
    client = _RecordingClient()
    _apply(
        _write(tmp_path, edited),
        client,
        FakeStore(legacy),
        retry=_retry_for(edited, recorded.checksum),
    )
    # What every release before #599 does with this state.
    assert client.calls == [_FP_D]


def test_apply_refuses_an_unchanged_file_whose_statements_no_longer_match(
    tmp_path: Path,
) -> None:
    recorded = _failed_fingerprint_run(tmp_path)
    client = _RecordingClient()
    store = FakeStore(recorded)
    # A plugin that now drops the first statement moves every other one.
    with pytest.raises(MigrateError) as info:
        _apply(
            _write(tmp_path, _FP_ORIGINAL),
            client,
            store,
            runtime=_FakeRuntime(lambda statements: statements[1:]),
        )
    assert info.value.code == "statement_split_changed"
    message = str(info.value)
    assert message.startswith(
        "Cannot resume m.sql: the journal recorded statements 1, 2 as completed or started, "
        "but this run gets different SQL from the file at those positions."
    )
    assert "chkit migrate --apply --abandon m.sql" in message
    assert client.calls == []
    assert store.writes == []


def test_apply_resumes_an_unchanged_file_whose_statements_match(tmp_path: Path) -> None:
    recorded = _failed_fingerprint_run(tmp_path)
    client = _RecordingClient()
    _apply(_write(tmp_path, _FP_ORIGINAL), client, FakeStore(recorded))
    assert client.calls == [_FP_C_BROKEN, _FP_D]


class _StaleFirstReadStore(FakeStore):
    """The first read sees no state (a stale replica); later reads see it."""

    def read_migration_state(self, name: str) -> MigrationRowState | None:
        self.reads.append(name)
        return None if len(self.reads) == 1 else self.state


def test_apply_checks_the_record_of_every_skip(tmp_path: Path) -> None:
    recorded = _failed_fingerprint_run(tmp_path)
    client = _RecordingClient()
    store = _StaleFirstReadStore(recorded)
    runtime = _FakeRuntime(lambda all_: [all_[0].replace("p_a", "p_x"), *all_[1:]])
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, _FP_ORIGINAL), client, store, runtime=runtime)
    assert info.value.code == "statement_split_changed"
    assert "the journal recorded statement 1 as completed or started" in str(info.value)
    assert client.calls == []


def test_apply_checks_another_releases_fingerprinted_state_by_fingerprint(
    tmp_path: Path,
) -> None:
    """The two splits differ on statement 1; its fingerprint shows the statement
    there is the one that ran."""
    sql = (
        "SELECT 1 // x; SELECT 2\n;\nALTER TABLE t ADD COLUMN b UInt64;\n"
        "ALTER TABLE t ADD COLUMN c UInt64;\n"
    )
    ran = "SELECT 1 // x; SELECT 2\n;"
    client = _RecordingClient()
    store = FakeStore(
        in_progress(
            [
                _with_fingerprint(op(0, "completed"), statement_fingerprint(ran)),
                op(1, "failed"),
            ],
            checksum=checksum_sql(sql),
        )
    )
    _apply(_write(tmp_path, sql), client, store)
    assert client.calls == [
        "ALTER TABLE t ADD COLUMN b UInt64;",
        "ALTER TABLE t ADD COLUMN c UInt64;",
    ]


class _AlwaysUnknownClient(_RecordingClient):
    """No replica runs the recorded async attempt, and query_log has nothing of it."""

    def __init__(self) -> None:
        super().__init__()
        self.status_ids: list[str] = []

    def query(self, _sql: str) -> QueryResult:
        return QueryResult(
            column_names=["now_ms", "database"],
            rows=[{"now_ms": "1700000000000", "database": "db"}],
        )

    def query_status(
        self,
        query_id: str,
        *,
        after_time: str | None = None,
        every_replica: bool = False,
        running_only: bool = False,
        include_before_start: bool = False,
    ) -> QueryStatus:
        _ = (after_time, every_replica, running_only, include_before_start)
        self.status_ids.append(query_id)
        return QueryStatus(status="unknown")

    def submit(self, *_args: Any, **_kwargs: Any) -> str:
        msg = "never submitted"
        raise AssertionError(msg)


def test_a_marker_key_edit_that_would_drop_an_unverified_failed_record_stops(
    tmp_path: Path,
) -> None:
    """#767 (round 3): an edit of only the marker's key drops the record of an
    async attempt that an earlier release journaled failed without a server
    failure (a lost response after the INSERT committed). The record is read
    against the identity it was recorded with first, and the run stops with
    the journal as it was: the INSERT would otherwise run again."""
    statement = "INSERT INTO db.a SELECT 1;"
    original = f"-- operation: load_table_data key=table:db.a risk=safe mode=async\n{statement}\n"
    edited = original.replace("key=table:db.a", "key=table:db.renamed")
    attempt = op(0, "failed", LOAD, query_id="legacy-query-id", last_error="error code: 524")
    store = FakeStore(
        in_progress(
            [attempt.model_copy(update={"fingerprint": statement_fingerprint(statement)})],
            checksum=checksum_sql(original),
        )
    )
    client = _AlwaysUnknownClient()
    with pytest.raises(MigrateError) as info:
        _apply(
            _write(tmp_path, edited),
            cast(Any, client),
            store,
            retry=_retry_for(edited, previous=checksum_sql(original)),
        )
    assert info.value.code == "async_outcome_unknown"
    assert "query_id legacy-query-id" in info.value.message
    assert client.status_ids == ["legacy-query-id"]
    assert client.calls == []
    assert store.writes == []


def test_a_migration_with_async_work_on_a_journal_that_cannot_fence_stops_before_it_runs(
    tmp_path: Path,
) -> None:
    """#767 (round 3): a journal that cannot store an async attempt's fence
    stops the migration before any statement runs, so nothing needs
    reconciling."""
    sql = (
        "-- operation: sql_statement key=statement:0 risk=safe\nINSERT INTO db.log VALUES (1);\n"
        "-- operation: load_table_data key=table:db.a risk=safe mode=async\n"
        "INSERT INTO db.a SELECT 1;\n"
    )
    store = FakeStore(fences=False)
    client = _RecordingClient()
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, sql), client, store)
    assert info.value.code == "async_attempt_unfenced"
    assert "Nothing ran. Add the column" in info.value.message
    assert client.calls == []
    assert store.writes == []


def test_a_mode_only_edit_of_a_prepared_attempt_runs_without_before_retry_sql(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 4): a prepared attempt with nothing of its id on the server
    was never sent and ran nothing, so the sync run gets no before-retry SQL."""
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _s: None)
    _store, client, run, statement = _mode_only_edit(
        tmp_path,
        QueryStatus(status="unknown"),
        last_error="prepared under its own query id; not submitted yet",
    )
    run()
    assert client.calls == [statement]
    # The sync path reuses the edit check's lookup: the check and its 5
    # query_log flush rechecks run once.
    assert len(client.checks) == 6


class _RewritingRuntime(_FakeRuntime):
    """A plugin whose onBeforeApply rewrites the statement, the file unchanged."""

    def __init__(self) -> None:
        super().__init__(lambda statements: [s.replace("SELECT 1", "SELECT 2") for s in statements])


@pytest.mark.parametrize("recorded", ["fenced-started", "unverified-failed"])
def test_a_plugin_rewrite_never_skips_the_reconcile_of_a_recorded_attempt(
    tmp_path: Path, recorded: str
) -> None:
    """#767 (round 4): with the file unchanged, a plugin's onBeforeApply
    rewrite changes the statement's fingerprint. The recorded attempt is still
    read as it was recorded, so a load that may have left rows stops the run
    instead of being compensated and run again."""
    statement = "INSERT INTO db.a SELECT 1;"
    sql = (
        "-- operation: load_table_data key=table:db.a risk=safe mode=async\n"
        f"-- before-retry: TRUNCATE TABLE db.a\n{statement}\n"
    )
    status = "started" if recorded == "fenced-started" else "failed"
    attempt = op(0, status, LOAD, query_id="recorded-query-id").model_copy(
        update={
            "last_error": (
                "submitted under its own query id; a retry reads its outcome from "
                "system.query_log"
                if recorded == "fenced-started"
                else "error code: 524"
            ),
            "fingerprint": statement_fingerprint(statement),
            "attempt_fenced": recorded == "fenced-started",
        }
    )
    store = FakeStore(in_progress([attempt], checksum=checksum_sql(sql)))
    client = _AlwaysUnknownClient()
    with pytest.raises(MigrateError) as info:
        _apply(_write(tmp_path, sql), cast(Any, client), store, runtime=_RewritingRuntime())
    # A started record of other SQL stops at the recorded-statements check;
    # a failed one at the record's own outcome.
    assert info.value.code == (
        "statement_split_changed" if recorded == "fenced-started" else "async_outcome_unknown"
    )
    assert client.calls == []
    assert store.writes == []



def test_a_plugin_that_drops_a_statement_with_an_unresolved_async_attempt_stops(
    tmp_path: Path,
) -> None:
    """#767 (round 5): a plugin's onBeforeApply that drops a statement with a
    recorded async attempt never marks the migration applied while that
    attempt has no outcome."""
    first = "ALTER TABLE db.a ADD COLUMN x UInt8;"
    load = "INSERT INTO db.a SELECT 1;"
    sql = f"{first}\n-- operation: load_table_data key=table:db.a risk=safe mode=async\n{load}\n"
    store = FakeStore(
        in_progress(
            [
                op(0, "completed").model_copy(
                    update={"fingerprint": statement_fingerprint(first)}
                ),
                op(1, "failed", LOAD, query_id="recorded-query-id").model_copy(
                    update={
                        "last_error": "error code: 524",
                        "fingerprint": statement_fingerprint(load),
                    }
                ),
            ],
            checksum=checksum_sql(sql),
        )
    )
    client = _AlwaysUnknownClient()
    with pytest.raises(MigrateError) as info:
        _apply(
            _write(tmp_path, sql),
            cast(Any, client),
            store,
            runtime=_FakeRuntime(lambda statements: statements[:1]),
        )
    assert info.value.code == "async_outcome_unknown"
    assert "query_id recorded-query-id" in info.value.message
    assert client.calls == []
    assert store.writes == []
    assert store.appended == []


class _PreparedRerunClient(_AlwaysUnknownClient):
    """Nothing of the prepared attempt on the server; its re-run finishes."""

    def __init__(self) -> None:
        super().__init__()
        self.submitted: list[str | None] = []

    def query_status(self, query_id: str, **kwargs: Any) -> QueryStatus:
        super().query_status(query_id, **kwargs)
        if query_id == "prepared-query-id" or not self.submitted:
            return QueryStatus(status="unknown")
        return QueryStatus(status="finished", written_rows=1, duration_ms=10)

    def submit(
        self,
        statement: str,
        query_id: str | None = None,
        settings: dict[str, Any] | None = None,
        *,
        before_send: Any = None,
    ) -> str:
        _ = (statement, settings)
        if before_send is not None:
            before_send()
            before_send.commit()
        self.submitted.append(query_id)
        return query_id or "x"


def test_an_async_rerun_after_a_retry_edit_looks_its_prepared_attempt_up_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#767 (round 6): an async statement after a --retry edit reuses the
    edit check's lookup of its prepared attempt: the check and its 5 query_log
    flush rechecks run once, then the attempt runs again under a new id."""
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _s: None)
    statement = "INSERT INTO db.a SELECT 1;"
    original = (
        "-- operation: load_table_data key=table:db.a risk=safe mode=async\n"
        f"-- before-retry: TRUNCATE TABLE db.a\n{statement}\n"
    )
    edited = f"-- an edited comment\n{original}"
    attempt = op(0, "started", LOAD, query_id="prepared-query-id").model_copy(
        update={
            "last_error": "prepared under its own query id; not submitted yet",
            "fingerprint": statement_fingerprint(statement),
            "attempt_fenced": True,
        }
    )
    store = FakeStore(in_progress([attempt], checksum=checksum_sql(original)))
    client = _PreparedRerunClient()
    _apply(
        _write(tmp_path, edited),
        cast(Any, client),
        store,
        retry=_retry_for(edited, previous=checksum_sql(original)),
    )
    assert client.status_ids.count("prepared-query-id") == 6
    assert len(client.submitted) == 1
    assert client.submitted[0] != "prepared-query-id"
    assert client.calls == []
    assert store.appended


class _OutcomeClient(_AlwaysUnknownClient):
    def __init__(self, outcome: str) -> None:
        super().__init__()
        self._outcome = outcome

    def query_status(self, query_id: str, **kwargs: Any) -> QueryStatus:
        super().query_status(query_id, **kwargs)
        if self._outcome == "finished":
            return QueryStatus(status="finished", written_rows=1, duration_ms=10)
        return QueryStatus(status=self._outcome)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("outcome", "code"),
    [
        ("running", "retry_mismatch"),
        ("unknown", "async_outcome_unknown"),
        ("finished", "statement_split_changed"),
    ],
)
def test_a_plugin_that_drops_a_statement_with_a_fenced_started_attempt_reads_it_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, outcome: str, code: str
) -> None:
    """#767 (round 6): a fenced started attempt the plugin dropped is read
    against its record before the recorded statements are checked."""
    monkeypatch.setattr("chkit.cli.commands.migrate_async_apply.time.sleep", lambda _s: None)
    first = "ALTER TABLE db.a ADD COLUMN x UInt8;"
    load = "INSERT INTO db.a SELECT 1;"
    sql = f"{first}\n-- operation: load_table_data key=table:db.a risk=safe mode=async\n{load}\n"
    store = FakeStore(
        in_progress(
            [
                op(0, "completed").model_copy(
                    update={"fingerprint": statement_fingerprint(first)}
                ),
                op(1, "started", LOAD, query_id="fenced-query-id").model_copy(
                    update={
                        "last_error": "submitted under its own query id; a retry reads its "
                        "outcome from system.query_log",
                        "fingerprint": statement_fingerprint(load),
                        "attempt_fenced": True,
                    }
                ),
            ],
            checksum=checksum_sql(sql),
        )
    )
    client = _OutcomeClient(outcome)
    with pytest.raises(MigrateError) as info:
        _apply(
            _write(tmp_path, sql),
            cast(Any, client),
            store,
            runtime=_FakeRuntime(lambda statements: statements[:1]),
        )
    assert info.value.code == code
    assert client.status_ids[0] == "fenced-query-id"
    assert client.calls == []
    assert store.writes == []
    assert store.appended == []


class _FirstLookupFinishesClient(_AlwaysUnknownClient):
    def query_status(self, query_id: str, **kwargs: Any) -> QueryStatus:
        super().query_status(query_id, **kwargs)
        if len(self.status_ids) == 1:
            return QueryStatus(status="finished", written_rows=1, duration_ms=10)
        return QueryStatus(status="unknown")


def test_an_async_statement_after_a_retry_edit_records_the_query_finish_the_check_read(
    tmp_path: Path,
) -> None:
    """#767 (round 6): a retained async statement takes the edit check's
    QueryFinish, even when a later lookup would find nothing."""
    statement = "INSERT INTO db.a SELECT 1;"
    original = f"-- operation: load_table_data key=table:db.a risk=safe mode=async\n{statement}\n"
    edited = f"-- an edited comment\n{original}"
    attempt = op(0, "started", LOAD, query_id="fenced-query-id").model_copy(
        update={
            "last_error": "submitted under its own query id; a retry reads its outcome from "
            "system.query_log",
            "fingerprint": statement_fingerprint(statement),
            "attempt_fenced": True,
        }
    )
    store = FakeStore(in_progress([attempt], checksum=checksum_sql(original)))
    client = _FirstLookupFinishesClient()
    _apply(
        _write(tmp_path, edited),
        cast(Any, client),
        store,
        retry=_retry_for(edited, previous=checksum_sql(original)),
    )
    assert client.status_ids == ["fenced-query-id"]
    assert store.state is not None
    assert store.state.operations[0].status == "completed"
    assert store.appended
