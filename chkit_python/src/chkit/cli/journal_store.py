"""ClickHouse-backed journal store for applied migrations.

Mirrors the TypeScript ``createJournalStore`` (``runtime/journal-store.ts``).
The journal lives in a ClickHouse table named ``_chkit_migrations`` (override
via the ``CHKIT_JOURNAL_TABLE`` env var). The schema matches the TS version
column-for-column so reading the same table from either implementation works.

This Python port focuses on the synchronous, applied-only subset:

- ``ensure_table`` creates ``_chkit_migrations`` if missing.
- ``read_journal`` returns the applied entries sorted by name.
- ``append_entry`` inserts a single applied row.
- ``find_checksum_mismatches`` compares journaled checksums against disk.

The per-operation, partially-applied tracking from TS (``operations`` tuple,
``migration_completed`` flag) is not modelled here — we always insert with
``migration_completed = true``. This matches the "synchronous apply, no async
ALTERs" path that the TS code takes when async tracking is disabled.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field

from chkit.cli.migration_store import (
    ChecksumMismatch,
    MigrationJournal,
    MigrationJournalEntry,
    checksum_sql,
    now_iso,
)
from chkit.clickhouse.client import ClickHouseClient

OperationStatus = Literal["started", "completed", "failed"]

_INSERT_RACE_MAX_ATTEMPTS = 5
_INSERT_RACE_BASE_DELAY_MS = 150


class OperationState(BaseModel):
    """Per-statement state recorded in the journal's ``operations`` tuple column."""

    model_config = ConfigDict(frozen=True, populate_by_name=True)

    operation_index: int = Field(..., alias="operationIndex")
    operation_key: str = Field(..., alias="operationKey")
    operation_type: str = Field(..., alias="operationType")
    query_id: str = Field(..., alias="queryId")
    status: OperationStatus
    started_at: str = Field(..., alias="startedAt")
    finished_at: str | None = Field(..., alias="finishedAt")
    last_error: str = Field(..., alias="lastError")


class MigrationRowState(BaseModel):
    """Full row state for one migration in the ``_chkit_migrations`` table."""

    model_config = ConfigDict(frozen=True, populate_by_name=True)

    name: str
    applied_at: str = Field(..., alias="appliedAt")
    checksum: str
    chkit_version: str = Field(..., alias="chkitVersion")
    migration_completed: bool = Field(..., alias="migrationCompleted")
    operations: list[OperationState]

_DEFAULT_JOURNAL_TABLE: Final[str] = "_chkit_migrations"
_JOURNAL_TABLE_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

_OPERATIONS_TUPLE_TYPE: Final[str] = (
    "Array(Tuple("
    "operation_index Int32, "
    "operation_key String, "
    "operation_type String, "
    "query_id String, "
    "status LowCardinality(String), "
    "started_at DateTime64(3, 'UTC'), "
    "finished_at Nullable(DateTime64(3, 'UTC')), "
    "last_error String"
    "))"
)


class _UnknownDatabaseError(Exception):
    pass


def resolve_journal_table_name() -> str:
    candidate = (os.environ.get("CHKIT_JOURNAL_TABLE") or "").strip()
    if not candidate:
        return _DEFAULT_JOURNAL_TABLE
    if _JOURNAL_TABLE_PATTERN.match(candidate) is None:
        msg = (
            f'Invalid CHKIT_JOURNAL_TABLE "{candidate}". '
            f"Expected unquoted identifier matching [A-Za-z_][A-Za-z0-9_]*"
        )
        raise ValueError(msg)
    return candidate


def _escape_sql_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def _parse_bool(value: Any) -> bool:
    """Normalize a ClickHouse Bool / 0|1 / "true"|"false" / true|false to Python bool."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value == 1
    if isinstance(value, str):
        return value.lower() in {"1", "true"}
    return False


def _parse_operations(value: Any) -> list[OperationState]:
    """Decode the ``toJSONString(operations)`` cell into OperationState objects."""
    if value is None or value == "":
        return []
    decoded: Any = value
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return []
    if not isinstance(decoded, list):
        return []
    out: list[OperationState] = []
    for raw in decoded:
        if not isinstance(raw, dict):
            continue
        out.append(
            OperationState(
                operation_index=int(raw.get("operation_index", 0)),
                operation_key=str(raw.get("operation_key", "")),
                operation_type=str(raw.get("operation_type", "")),
                query_id=str(raw.get("query_id", "")),
                status=str(raw.get("status", "started")),  # type: ignore[arg-type]
                started_at=str(raw.get("started_at", "")),
                finished_at=(
                    None
                    if raw.get("finished_at") is None
                    else str(raw["finished_at"])
                ),
                last_error=str(raw.get("last_error", "")),
            )
        )
    return out


def _operation_to_tuple_literal(op: OperationState) -> str:
    parts = [
        str(op.operation_index),
        f"'{_escape_sql_string(op.operation_key)}'",
        f"'{_escape_sql_string(op.operation_type)}'",
        f"'{_escape_sql_string(op.query_id)}'",
        f"'{_escape_sql_string(op.status)}'",
        f"'{_escape_sql_string(op.started_at)}'",
        "NULL" if op.finished_at is None else f"'{_escape_sql_string(op.finished_at)}'",
        f"'{_escape_sql_string(op.last_error)}'",
    ]
    return f"({','.join(parts)})"


def _operations_array_literal(operations: list[OperationState]) -> str:
    if not operations:
        return "[]"
    return f"[{','.join(_operation_to_tuple_literal(op) for op in operations)}]"


def _is_retryable_insert_race(error: BaseException) -> bool:
    message = str(error)
    return "INSERT race condition" in message or "Please retry the INSERT" in message


def _is_unknown_database_error(error: BaseException) -> bool:
    """Detect the "Database X doesn't exist" error from clickhouse-connect."""
    text = str(error)
    return (
        "Code: 81" in text  # UNKNOWN_DATABASE
        or "doesn't exist" in text
        or ("does not exist" in text
        and "DB::Exception" in text)
    )


class JournalStore:
    """Imperative wrapper over the ``_chkit_migrations`` table."""

    __slots__ = ("_bootstrapped", "_client", "_database_missing", "_table")

    def __init__(self, client: ClickHouseClient) -> None:
        self._client: ClickHouseClient = client
        self._table: str = resolve_journal_table_name()
        self._bootstrapped: bool = False
        self._database_missing: bool = False

    @property
    def database_missing(self) -> bool:
        return self._database_missing

    @property
    def table_name(self) -> str:
        return self._table

    def _create_table_sql(self) -> str:
        return (
            f"CREATE TABLE IF NOT EXISTS {self._table} (\n"
            f"    name String,\n"
            f"    applied_at DateTime64(3, 'UTC'),\n"
            f"    checksum String,\n"
            f"    chkit_version String,\n"
            f"    migration_completed Bool DEFAULT true,\n"
            f"    operations {_OPERATIONS_TUPLE_TYPE} DEFAULT []\n"
            f") ENGINE = ReplacingMergeTree(applied_at)\n"
            f"ORDER BY (name)\n"
            f"SETTINGS index_granularity = 1"
        )

    def _ensure_table(self) -> None:
        if self._bootstrapped:
            return
        try:
            self._client.query(f"SELECT name FROM {self._table} LIMIT 0")
            self._ensure_schema_upgraded()
            self._bootstrapped = True
            return
        except Exception as exc:
            if _is_unknown_database_error(exc):
                self._database_missing = True
                self._bootstrapped = True
                return
        try:
            self._client.execute(self._create_table_sql())
        except Exception as exc:
            if _is_unknown_database_error(exc):
                self._database_missing = True
                self._bootstrapped = True
                return
            raise
        self._bootstrapped = True

    def _ensure_schema_upgraded(self) -> None:
        # Old journal tables predate per-operation tracking. Add the columns
        # idempotently. ``ADD COLUMN IF NOT EXISTS`` is a metadata-only op.
        self._client.execute(
            f"ALTER TABLE {self._table} "
            f"ADD COLUMN IF NOT EXISTS migration_completed Bool DEFAULT true"
        )
        self._client.execute(
            f"ALTER TABLE {self._table} "
            f"ADD COLUMN IF NOT EXISTS operations {_OPERATIONS_TUPLE_TYPE} DEFAULT []"
        )

    def _try_sync_replica(self) -> None:
        # Non-replicated/single-node setups don't support SYSTEM SYNC REPLICA.
        with contextlib.suppress(Exception):
            self._client.execute(f"SYSTEM SYNC REPLICA {self._table}")

    def read_journal(
        self, *, project_files: list[str] | None = None
    ) -> MigrationJournal:
        """Return applied entries. When ``project_files`` is set, scopes the WHERE.

        Multiple chkit projects can share one ``_chkit_migrations`` table on a
        managed ObsessionDB tenant. Without scoping, every project sees every
        project's rows — which surfaced as the stale "Applied: 2 / Pending: 0"
        bug. Pass the list of filenames in the project's migrations dir to
        filter the query to just this project.
        """
        self._ensure_table()
        if self._database_missing:
            return MigrationJournal()
        self._try_sync_replica()
        where = "migration_completed = true"
        if project_files:
            quoted = ", ".join(
                f"'{_escape_sql_string(name)}'" for name in project_files
            )
            where = f"{where} AND name IN ({quoted})"
        result = self._client.query(
            f"SELECT name, applied_at, checksum FROM {self._table} FINAL "
            f"WHERE {where} ORDER BY name "
            f"SETTINGS select_sequential_consistency = 1"
        )
        applied = [
            MigrationJournalEntry(
                name=str(row["name"]),
                applied_at=str(row["applied_at"]),
                checksum=str(row["checksum"]),
            )
            for row in result.rows
        ]
        return MigrationJournal(applied=applied)

    def append_entry(self, entry: MigrationJournalEntry, *, chkit_version: str) -> None:
        """Flip migration_completed=true; preserve any existing operations[]."""
        existing = self.read_migration_state(entry.name)
        self.write_migration_state(
            MigrationRowState(
                name=entry.name,
                applied_at=entry.applied_at,
                checksum=entry.checksum,
                chkit_version=chkit_version,
                migration_completed=True,
                operations=existing.operations if existing is not None else [],
            )
        )

    def read_migration_state(self, migration_name: str) -> MigrationRowState | None:
        """Return the latest row for ``migration_name`` (including in-progress)."""
        self._ensure_table()
        if self._database_missing:
            return None
        self._try_sync_replica()
        result = self._client.query(
            f"SELECT name, applied_at, checksum, chkit_version, "
            f"migration_completed, toJSONString(operations) AS operations "
            f"FROM {self._table} FINAL "
            f"WHERE name = '{_escape_sql_string(migration_name)}' "
            f"LIMIT 1 SETTINGS select_sequential_consistency = 1"
        )
        if not result.rows:
            return None
        row = result.rows[0]
        return MigrationRowState(
            name=str(row["name"]),
            applied_at=str(row["applied_at"]),
            checksum=str(row["checksum"]),
            chkit_version=str(row["chkit_version"]),
            migration_completed=_parse_bool(row.get("migration_completed")),
            operations=_parse_operations(row.get("operations")),
        )

    def write_migration_state(self, state: MigrationRowState) -> None:
        """Upsert one migration row with INSERT race retry (5 x backoff)."""
        if self._database_missing:
            self._database_missing = False
            self._bootstrapped = False
        self._ensure_table()
        sql = (
            f"INSERT INTO {self._table} "
            f"(name, applied_at, checksum, chkit_version, "
            f"migration_completed, operations) VALUES ("
            f"'{_escape_sql_string(state.name)}', "
            f"'{_escape_sql_string(state.applied_at)}', "
            f"'{_escape_sql_string(state.checksum)}', "
            f"'{_escape_sql_string(state.chkit_version)}', "
            f"{'true' if state.migration_completed else 'false'}, "
            f"{_operations_array_literal(state.operations)}"
            f")"
        )
        for attempt in range(1, _INSERT_RACE_MAX_ATTEMPTS + 1):
            try:
                self._client.execute(sql)
                break
            except Exception as exc:
                if (
                    not _is_retryable_insert_race(exc)
                    or attempt == _INSERT_RACE_MAX_ATTEMPTS
                ):
                    raise
                time.sleep(attempt * _INSERT_RACE_BASE_DELAY_MS / 1000)
        self._try_sync_replica()


def find_checksum_mismatches_against_disk(
    migrations_dir: Path, journal: MigrationJournal
) -> list[ChecksumMismatch]:
    """Re-exported for command modules; identical to migration_store version."""
    mismatches: list[ChecksumMismatch] = []
    for entry in journal.applied:
        if not entry.checksum:
            continue
        path = migrations_dir / entry.name
        if not path.exists():
            continue
        actual = checksum_sql(path.read_text(encoding="utf-8"))
        if actual != entry.checksum:
            mismatches.append(
                ChecksumMismatch(
                    name=entry.name, expected=entry.checksum, actual=actual
                )
            )
    return mismatches


def now_iso_for_journal() -> str:
    return now_iso()
