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
import os
import re
from pathlib import Path
from typing import Final

from chkit.cli.migration_store import (
    ChecksumMismatch,
    MigrationJournal,
    MigrationJournalEntry,
    checksum_sql,
    now_iso,
)
from chkit.clickhouse.client import ClickHouseClient

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

    def read_journal(self) -> MigrationJournal:
        self._ensure_table()
        if self._database_missing:
            return MigrationJournal()
        self._try_sync_replica()
        result = self._client.query(
            f"SELECT name, applied_at, checksum FROM {self._table} FINAL "
            f"WHERE migration_completed = true ORDER BY name "
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
        if self._database_missing:
            self._database_missing = False
            self._bootstrapped = False
        self._ensure_table()
        sql = (
            f"INSERT INTO {self._table} "
            f"(name, applied_at, checksum, chkit_version, "
            f"migration_completed, operations) VALUES ("
            f"'{_escape_sql_string(entry.name)}', "
            f"'{_escape_sql_string(entry.applied_at)}', "
            f"'{_escape_sql_string(entry.checksum)}', "
            f"'{_escape_sql_string(chkit_version)}', "
            f"true, []"
            f")"
        )
        self._client.execute(sql)
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
