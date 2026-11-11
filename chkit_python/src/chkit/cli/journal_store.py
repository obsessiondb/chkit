"""ClickHouse-backed journal store for applied migrations.

Mirrors the TypeScript ``createJournalStore`` (``runtime/journal-store.ts``).
The journal lives in a ClickHouse table named ``_chkit_migrations`` (override
via the ``CHKIT_JOURNAL_TABLE`` env var). The schema matches the TS version
column-for-column so reading the same table from either implementation works.

This Python port focuses on the synchronous, applied-only subset:

- the first write creates ``_chkit_migrations`` if missing; reads never write.
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
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final, Literal, TypeVar

import typer
from pydantic import BaseModel, ConfigDict, Field

from chkit import __version__
from chkit.cli.create_table_columns import create_table_element_names
from chkit.cli.logging_setup import debug
from chkit.cli.migration_store import (
    ChecksumMismatch,
    MigrationJournal,
    MigrationJournalEntry,
    checksum_sql,
)
from chkit.clickhouse.client import (
    ClickHouseClient,
    clickhouse_error_message,
    is_unknown_database_error,
)
from chkit.clickhouse.ddl_propagation import (
    MAX_RETRIES,
    RETRY_DELAY_SECONDS,
    wait_for_column,
    wait_for_table,
)
from chkit.clickhouse.replicas import (
    ReplicaFanout,
    all_replicas,
    resolve_replica_fanout_or_raise,
)
from chkit.core.identifier import quote_identifier
from chkit.core.on_cluster import on_cluster_clause
from chkit.core.sql_lexer import js_regex, js_trim

_T = TypeVar("_T")

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
    # The ``statement_fingerprint`` of the statement this record is about, so a
    # resume can tell it is still that statement (#599). Empty when it was not
    # recorded: an older chkit wrote the row, or the journal has no column for
    # it. Never part of a report.
    fingerprint: str = Field(..., exclude=True)


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

# One fingerprint per entry of ``operations``, in the same order (#599). A
# separate column, so the ``operations`` type older releases write stays the
# same. Older releases name their INSERT columns, so a row they write gets
# ``[]`` here: a fingerprint is only ever read from a row whose writer recorded
# it for that very record.
_FINGERPRINTS_COLUMN: Final[str] = "operation_fingerprints"
_FINGERPRINTS_COLUMN_DEFINITION: Final[str] = f"{_FINGERPRINTS_COLUMN} Array(String) DEFAULT []"


class _UnknownDatabaseError(Exception):
    pass


def resolve_journal_table_name() -> str:
    candidate = js_trim(os.environ.get("CHKIT_JOURNAL_TABLE") or "")
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


def _row_version(applied_at: str) -> datetime:
    """The ``ReplacingMergeTree(applied_at)`` version: UTC, millisecond precision."""
    parsed = datetime.fromisoformat(applied_at.strip().replace(" ", "T"))
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(UTC).replace(tzinfo=None)
    return parsed.replace(microsecond=parsed.microsecond // 1000 * 1000)


def _parse_bool(value: Any) -> bool:
    """Normalize a ClickHouse Bool / 0|1 / "true"|"false" / true|false to Python bool."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value == 1
    if isinstance(value, str):
        return value.lower() in {"1", "true"}
    return False


def _parse_json_list(value: Any) -> list[Any]:
    if value is None or value == "":
        return []
    decoded: Any = value
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return []
    return decoded if isinstance(decoded, list) else []


def _parse_fingerprints(value: Any, operation_count: int) -> list[str]:
    """The fingerprints count only when there is one per operation: a row an
    older release wrote has ``[]``, and its operations then have none."""
    decoded = _parse_json_list(value)
    if len(decoded) != operation_count or not all(isinstance(item, str) for item in decoded):
        return []
    return [str(item) for item in decoded]


def _parse_operations(value: Any, fingerprints_value: Any = None) -> list[OperationState]:
    """Decode the ``toJSONString(operations)`` cell into OperationState objects."""
    decoded = _parse_json_list(value)
    fingerprints = _parse_fingerprints(fingerprints_value, len(decoded))
    out: list[OperationState] = []
    for index, raw in enumerate(decoded):
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
                fingerprint=fingerprints[index] if index < len(fingerprints) else "",
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


def _fingerprints_array_literal(operations: list[OperationState]) -> str:
    quoted = ["'" + _escape_sql_string(op.fingerprint) + "'" for op in operations]
    return f"[{','.join(quoted)}]"


# ClickHouse errors by code, name and message. clickhouse-connect gives the code
# and the name in the message; the ObsessionDB console API only the message.
# Same as TS ``isClickHouseError``.
_UNKNOWN_TABLE = (
    60,
    "UNKNOWN_TABLE",
    re.compile(js_regex(r"Unknown table expression identifier|Table \S+ does not exist")),
)
_UNKNOWN_IDENTIFIER = (
    47,
    "UNKNOWN_IDENTIFIER",
    re.compile(r"Unknown expression identifier|Missing columns"),
)
_READONLY = (164, "READONLY", re.compile(r"in readonly mode"))
_ACCESS_DENIED = (497, "ACCESS_DENIED", re.compile(r"Not enough privileges"))


def _is_clickhouse_error(error: BaseException, kind: tuple[int, str, re.Pattern[str]]) -> bool:
    code, name, message = kind
    text = str(error)
    return f"Code: {code}." in text or name in text or message.search(text) is not None


def _fingerprint_column_warning(table: str, error: BaseException) -> str:
    """The one line a run prints when it cannot add the fingerprint column, so
    a user without ALTER on the journal knows the SQL check of --retry is off."""
    lines = clickhouse_error_message(error).split("\n")
    reason = js_trim(lines[0]).removesuffix(".")
    return (
        f"⚠ Could not add the {_FINGERPRINTS_COLUMN} column to {table} ({reason}), so this "
        "run records no statement fingerprints: a later --retry or resume checks the "
        'statements it completes by position and "-- operation:" marker only, not by '
        f"their SQL. The next migration applied by a user that can ALTER {table} adds "
        "the column."
    )


def _is_retryable_insert_race(error: BaseException) -> bool:
    message = str(error)
    return "INSERT race condition" in message or "Please retry the INSERT" in message


class JournalStore:
    """Imperative wrapper over the ``_chkit_migrations`` table.

    Pass ``cluster`` to opt into cluster mode: DDL statements this store emits
    are stamped with ``ON CLUSTER '<name>'`` and the journal itself is
    stored in a ``ReplicatedReplacingMergeTree`` engine on a no-``{shard}``
    Keeper path (one cluster-wide replication group). Leave ``cluster`` unset
    for single-node, ClickHouse Cloud, or ObsessionDB.
    """

    __slots__ = (
        "_bootstrapped",
        "_client",
        "_cluster",
        "_columns_unreadable",
        "_database_missing",
        "_database_name_read",
        "_fingerprint_column",
        "_fingerprint_column_added",
        "_last_written",
        "_on_cluster",
        "_table",
        "_table_missing",
    )

    def __init__(
        self, client: ClickHouseClient, cluster: str | None = None
    ) -> None:
        self._client: ClickHouseClient = client
        self._table: str = resolve_journal_table_name()
        self._cluster: str | None = cluster
        self._on_cluster: str = on_cluster_clause(cluster)
        self._bootstrapped: bool = False
        self._database_missing: bool = False
        # The database exists but the journal does not: reads see no rows, and
        # the first write creates it.
        self._table_missing: bool = False
        # Whether the journal has the operation_fingerprints column (#599). It
        # is False only once chkit saw that the column is missing, in a journal
        # an older release created: this run then reads and writes it as that
        # release does. Any other failure to tell stops the run instead, so
        # fingerprints that were recorded are never read as missing.
        self._fingerprint_column: bool = False
        self._fingerprint_column_added: bool = False
        # The user may not read system.columns; the column is then read from
        # the journal's definition in system.tables.
        self._columns_unreadable: bool = False
        # currentDatabase(), once it answered.
        self._database_name_read: str | None = None
        # Read-your-writes: the last row version this store wrote per migration.
        self._last_written: dict[str, MigrationRowState] = {}

    @property
    def database_missing(self) -> bool:
        return self._database_missing

    @property
    def table_name(self) -> str:
        return self._table

    def _create_table_sql(self, database: str) -> str:
        # In cluster mode the journal must be consistent across every node, so
        # it uses a replicated engine with a no-``{shard}`` Keeper path (one
        # cluster-wide replication group) created ``ON CLUSTER``. ``{uuid}`` is
        # minted once per CREATE and propagated to all nodes, so a dropped
        # journal's stale Keeper entries can never collide with a recreate
        # (REPLICA_ALREADY_EXISTS). The replica id is ``{shard}_{replica}``
        # rather than bare ``{replica}``: because the path omits ``{shard}``,
        # all nodes across all shards share it, so the replica name must be
        # unique cluster-wide — per-shard ``{replica}`` naming (the common
        # multi-shard layout) would otherwise collide. The read path already
        # uses SYNC REPLICA + FINAL + sequential consistency. Single-node/Cloud
        # keeps the plain engine. The table is named in its database: the client
        # retries a statement that fails with UNKNOWN_DATABASE without the
        # database, which would otherwise create the journal in the server's
        # default database (#493).
        engine = (
            "ReplicatedReplacingMergeTree("
            "'/clickhouse/tables/{uuid}/chkit_journal', "
            "'{shard}_{replica}', applied_at)"
            if self._cluster
            else "ReplacingMergeTree(applied_at)"
        )
        return (
            f"CREATE TABLE IF NOT EXISTS {quote_identifier(database)}.{self._table}"
            f"{self._on_cluster} (\n"
            f"    name String,\n"
            f"    applied_at DateTime64(3, 'UTC'),\n"
            f"    checksum String,\n"
            f"    chkit_version String,\n"
            f"    migration_completed Bool DEFAULT true,\n"
            f"    operations {_OPERATIONS_TUPLE_TYPE} DEFAULT [],\n"
            f"    {_FINGERPRINTS_COLUMN_DEFINITION}\n"
            f") ENGINE = {engine}\n"
            f"ORDER BY (name)\n"
            f"SETTINGS index_granularity = 1"
        )

    def _ensure_table(self, *, create: bool) -> None:
        """Make sure the journal can be read or, with ``create``, written.

        Only a write creates the journal or adds the columns an old one lacks,
        so status, check and migrate (plan) run as a read-only user (#402).
        """
        if self._bootstrapped or (self._table_missing and not create):
            return
        try:
            self._client.query(
                f"SELECT name, migration_completed, operations FROM {self._table} LIMIT 0"
            )
        except Exception as exc:
            if is_unknown_database_error(exc):
                self._database_missing = True
                self._bootstrapped = True
                return
            if _is_clickhouse_error(exc, _UNKNOWN_IDENTIFIER):
                # The journal predates per-operation tracking. Every replica
                # must have it before its ALTERs run (#700).
                self._wait_for_every_replica()
                self._ensure_schema_upgraded()
                self._fingerprint_column = self._detect_fingerprint_column()
                self._bootstrapped = True
                return
            if not create:
                if not _is_clickhouse_error(exc, _UNKNOWN_TABLE):
                    raise
                if self._exists_on_another_replica():
                    self._wait_for_every_replica()
                    self._fingerprint_column = self._detect_fingerprint_column()
                    self._bootstrapped = True
                    return
                self._table_missing = True
                return
        else:
            # Only the probe's own error is read above: a failure of the
            # waits after it stops the run (#700).
            self._wait_for_every_replica()
            self._fingerprint_column = self._detect_fingerprint_column()
            self._bootstrapped = True
            self._table_missing = False
            return
        self._create_journal_table()
        self._wait_for_every_replica()
        # Another process, maybe an older release, may have created it first.
        self._fingerprint_column = self._detect_fingerprint_column()
        self._bootstrapped = True
        self._table_missing = False

    def _while_database_propagates(self, what: str, run: Callable[[], _T]) -> _T:
        """Run ``run``, retrying it while it reaches a replica without the database.

        The probe found the database, so UNKNOWN_DATABASE here means the
        request reached a replica that has not applied ``CREATE DATABASE`` yet
        (#493): retry until it has. A database that never arrives stops the
        run, so the state being written is never dropped.
        """
        for attempt in range(1, MAX_RETRIES + 2):
            try:
                return run()
            except Exception as exc:
                if not is_unknown_database_error(exc):
                    raise
                if attempt > MAX_RETRIES:
                    # The server's message is left out, so the error never
                    # reads as a missing database itself; it stays the cause.
                    msg = (
                        f"Cannot {what}: its database is still missing on the replica "
                        f"that received the request after {attempt} attempts. Re-run "
                        "chkit once the database has reached every replica."
                    )
                    raise RuntimeError(msg) from exc
                debug(
                    "journal",
                    f"database not yet on this replica — retrying to {what} "
                    f"(attempt {attempt})",
                )
                time.sleep(RETRY_DELAY_SECONDS)
        raise AssertionError("unreachable")

    def _create_journal_table(self) -> None:
        self._while_database_propagates(
            f"create the journal table {self._table}",
            lambda: self._client.execute(self._create_table_sql(self._database_name())),
        )

    def _database_name(self) -> str:
        """currentDatabase(), read once it answers."""
        if self._database_name_read is None:
            self._database_name_read = self._while_database_propagates(
                f"read the database of {self._table}", self._current_database
            )
        return self._database_name_read

    def _qualified_table(self) -> str:
        """The journal as ``database.table``.

        The client retries a statement that fails with UNKNOWN_DATABASE
        without the database, so every journal INSERT and ALTER names it, or
        one that reaches a replica without the database would write a journal
        in the server's default database (#700).
        """
        return f"{quote_identifier(self._database_name())}.{self._table}"

    def _replica_fanout(self) -> ReplicaFanout | None:
        """The replicas to wait for.

        A probe that fails for another reason than a missing cluster or a
        user that cannot query it stops the run, rather than skip the waits
        that keep journal writes off a replica without the journal (#700).
        """
        return self._while_database_propagates(
            "discover the replicas of the journal",
            lambda: resolve_replica_fanout_or_raise(self._client, self._cluster),
        )

    def _exists_on_another_replica(self) -> bool:
        # On a multi-replica target, the replica that answered the probe may
        # not have applied another process's CREATE yet.
        fanout = self._replica_fanout()
        if fanout is None:
            return False
        rows = self._client.query(
            f"SELECT count() AS replicas FROM {all_replicas(fanout, 'system.tables')} "
            f"WHERE database = currentDatabase() AND name = '{self._table}'"
        ).rows
        return bool(rows) and int(rows[0]["replicas"]) > 0

    def _wait_for_every_replica(self) -> None:
        """Wait until every replica has the journal table (#265).

        A multi-replica target reads the journal from every replica, which
        fails while one of them does not have the table yet, e.g. right after
        the CREATE above or another process's. A single replica needs no wait.
        """
        if self._replica_fanout() is None:
            return
        wait_for_table(self._client, self._database_name(), self._table, cluster=self._cluster)

    def _current_database(self) -> str:
        rows = self._client.query("SELECT currentDatabase() AS database").rows
        return str(rows[0].get("database", "default")) if rows else "default"

    def _detect_fingerprint_column(self) -> bool:
        """Whether the journal has the fingerprint column.

        Only a server that says the column is missing makes it False; any
        other error stops the run. On several replicas, the column counts when
        any replica has it (one that lags may not yet), and then every replica
        must get it, because reads and writes name it.
        """
        fanout = self._replica_fanout()
        if fanout is None:
            try:
                self._client.query(f"SELECT {_FINGERPRINTS_COLUMN} FROM {self._table} LIMIT 0")
            except Exception as exc:
                if not _is_clickhouse_error(exc, _UNKNOWN_IDENTIFIER):
                    raise
                return False
            return True
        try:
            rows = self._client.query(
                f"SELECT count() AS replicas FROM {all_replicas(fanout, 'system.columns')} "
                f"WHERE database = currentDatabase() AND table = '{self._table}' "
                f"AND name = '{_FINGERPRINTS_COLUMN}'"
            ).rows
        except Exception as exc:
            if not _is_clickhouse_error(exc, _ACCESS_DENIED):
                raise
            debug(
                "journal",
                "cannot read system.columns — reading the journal definition from "
                f"system.tables: {clickhouse_error_message(exc)}",
            )
            self._columns_unreadable = True
            return self._detect_fingerprint_column_from_tables(fanout)
        if not rows or int(rows[0]["replicas"]) == 0:
            return False
        wait_for_column(
            self._client,
            self._database_name(),
            self._table,
            _FINGERPRINTS_COLUMN,
            cluster=self._cluster,
        )
        return True

    def _replicas_with_fingerprint_column(self, fanout: ReplicaFanout) -> tuple[int, int]:
        """How many replicas list the journal, and how many define the column.

        Read from each replica's CREATE statement in system.tables, for a user
        that cannot read system.columns (#402): it answers per replica, as
        system.columns does. A probe through the journal itself cannot,
        because a remote query takes its columns from one replica, and
        ``hasColumnInTable`` is folded into a constant on the replica that runs
        the query. The CREATE statement is read whatever identifier quoting the
        user's settings choose; one chkit cannot read stops the run.
        """
        rows = self._client.query(
            "SELECT hostName() AS replica, create_table_query FROM "
            f"{all_replicas(fanout, 'system.tables')} "
            f"WHERE database = currentDatabase() AND name = '{self._table}'"
        ).rows
        replicas: set[str] = set()
        with_column: set[str] = set()
        for row in rows:
            replica = str(row["replica"])
            replicas.add(replica)
            names = create_table_element_names(str(row["create_table_query"]))
            if names is None:
                msg = (
                    f"Cannot tell whether the journal table {self._table} has the "
                    f"{_FINGERPRINTS_COLUMN} column: cannot read its definition on replica "
                    f"{replica}."
                )
                raise RuntimeError(msg)
            if _FINGERPRINTS_COLUMN in names:
                with_column.add(replica)
        return len(replicas), len(with_column)

    def _detect_fingerprint_column_from_tables(self, fanout: ReplicaFanout) -> bool:
        """``_detect_fingerprint_column`` without system.columns.

        The column is missing only when every replica lists the journal
        without it; when a replica does not list the journal, chkit cannot
        tell, and stops rather than read recorded fingerprints as missing. A
        column some replicas have is waited for.
        """
        replicas, with_column = self._replicas_with_fingerprint_column(fanout)
        if with_column > 0:
            self._wait_for_fingerprint_column_in_tables(fanout)
            return True
        if replicas < fanout.replicas:
            msg = (
                f"Cannot tell whether the journal table {self._table} has the "
                f"{_FINGERPRINTS_COLUMN} column: {replicas} of {fanout.replicas} replicas "
                "list it. Re-run chkit once every replica has the table."
            )
            raise RuntimeError(msg)
        debug("journal", f"no replica has the {_FINGERPRINTS_COLUMN} column")
        return False

    def _wait_for_fingerprint_column_in_tables(self, fanout: ReplicaFanout) -> None:
        for attempt in range(MAX_RETRIES + 1):
            _, with_column = self._replicas_with_fingerprint_column(fanout)
            if with_column >= fanout.replicas:
                return
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY_SECONDS)
        msg = f"waitForColumn: {self._table}.{_FINGERPRINTS_COLUMN} not yet visible"
        raise RuntimeError(msg)

    def _wait_for_fingerprint_column(self, fanout: ReplicaFanout) -> None:
        """Wait until every replica has the fingerprint column, after this run added it."""
        if self._columns_unreadable:
            self._wait_for_fingerprint_column_in_tables(fanout)
            return
        wait_for_column(
            self._client,
            self._database_name(),
            self._table,
            _FINGERPRINTS_COLUMN,
            cluster=self._cluster,
        )

    def _ensure_fingerprint_column(self) -> None:
        """Add the fingerprint column to a journal an older release created.

        On the first write of a run. A user that cannot ALTER the journal
        still migrates, without fingerprints, as before (#599).
        """
        if self._fingerprint_column or self._fingerprint_column_added:
            return
        self._fingerprint_column_added = True
        try:
            self._client.execute(
                f"ALTER TABLE {self._qualified_table()}{self._on_cluster} "
                f"ADD COLUMN IF NOT EXISTS {_FINGERPRINTS_COLUMN_DEFINITION}"
            )
        except Exception as exc:
            debug(
                "journal",
                f"could not add {_FINGERPRINTS_COLUMN} — recording no fingerprints: "
                f"{clickhouse_error_message(exc)}",
            )
            typer.echo(_fingerprint_column_warning(self._table, exc), err=True)
            return
        fanout = self._replica_fanout()
        if fanout is not None:
            self._wait_for_fingerprint_column(fanout)
        self._fingerprint_column = True

    def _ensure_schema_upgraded(self) -> None:
        # Old journal tables predate per-operation tracking. Add the columns
        # idempotently. ``ADD COLUMN IF NOT EXISTS`` is a metadata-only op.
        # In cluster mode both ALTERs carry ``ON CLUSTER '<name>'`` so every
        # replica converges on the new column set in the same DDL round-trip.
        try:
            self._client.execute(
                f"ALTER TABLE {self._qualified_table()}{self._on_cluster} "
                f"ADD COLUMN IF NOT EXISTS migration_completed Bool DEFAULT true"
            )
            self._client.execute(
                f"ALTER TABLE {self._qualified_table()}{self._on_cluster} "
                f"ADD COLUMN IF NOT EXISTS operations {_OPERATIONS_TUPLE_TYPE} DEFAULT []"
            )
            self._client.execute(
                f"ALTER TABLE {self._qualified_table()}{self._on_cluster} "
                f"ADD COLUMN IF NOT EXISTS {_FINGERPRINTS_COLUMN_DEFINITION}"
            )
        except Exception as exc:
            # A read-only user cannot run the ALTER (#402). Same message as TS.
            raise RuntimeError(
                f"The journal table {self._table} predates per-operation tracking and needs "
                "its new columns added. Run chkit once as a user that can ALTER it "
                f"(as migrate --apply needs). {exc}"
            ) from exc

    def _journal_rows(self, where: str, *, limit: str = "") -> list[dict[str, Any]]:
        """The rows to read the journal from.

        A single replica reads the table with FINAL. With several replicas
        (#265), the replica a read lands on may not have the latest version
        yet, while the replica that ran an INSERT always has it: read every
        replica and keep the newest version per migration. Each write stamps
        ``applied_at`` in milliseconds as the row version, which is what
        ``ReplacingMergeTree(applied_at)`` keeps too.
        """
        fingerprints = self._fingerprint_column
        fanout = self._replica_fanout()
        fingerprint_select = f"toJSONString({_FINGERPRINTS_COLUMN})"
        if fanout is None:
            fingerprint_column = (
                f", {fingerprint_select} AS {_FINGERPRINTS_COLUMN}" if fingerprints else ""
            )
            sql = (
                f"SELECT name, applied_at, checksum, chkit_version, "
                f"migration_completed, toJSONString(operations) AS operations{fingerprint_column} "
                f"FROM {self._table} FINAL WHERE {where} ORDER BY name{limit}"
            )
            try:
                return self._client.query(
                    f"{sql} SETTINGS select_sequential_consistency = 1"
                ).rows
            except Exception as exc:
                # A readonly = 1 user cannot change any setting (#402). It only
                # reads, so there is no write of its own to wait for.
                if not _is_clickhouse_error(exc, _READONLY):
                    raise
                return self._client.query(sql).rows
        # The fingerprints come from the same row version as the operations.
        latest = f", latest.6 AS {_FINGERPRINTS_COLUMN}" if fingerprints else ""
        versioned = f", {fingerprint_select}" if fingerprints else ""
        return self._client.query(
            "SELECT name, latest.1 AS applied_at, latest.2 AS checksum, "
            "latest.3 AS chkit_version, latest.4 AS migration_completed, "
            f"latest.5 AS operations{latest} FROM (SELECT name, argMax(tuple(applied_at, "
            f"checksum, chkit_version, migration_completed, toJSONString(operations){versioned}), "
            "applied_at) AS latest FROM clusterAllReplicas("
            f"'{_escape_sql_string(fanout.cluster)}', currentDatabase(), '{self._table}') "
            f"GROUP BY name) WHERE {where} ORDER BY name{limit}"
        ).rows

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
        self._ensure_table(create=False)
        if self._database_missing or self._table_missing:
            return MigrationJournal()
        self._try_sync_replica()
        where = "migration_completed = true"
        if project_files:
            quoted = ", ".join(
                f"'{_escape_sql_string(name)}'" for name in project_files
            )
            where = f"{where} AND name IN ({quoted})"
        applied = [
            MigrationJournalEntry(
                name=str(row["name"]),
                applied_at=str(row["applied_at"]),
                checksum=str(row["checksum"]),
            )
            for row in self._journal_rows(where)
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
        self._ensure_table(create=False)
        if self._database_missing or self._table_missing:
            return None
        self._try_sync_replica()
        rows = self._journal_rows(
            f"name = '{_escape_sql_string(migration_name)}'", limit=" LIMIT 1"
        )
        written = self._last_written.get(migration_name)
        if not rows:
            return written
        row = rows[0]
        state = MigrationRowState(
            name=str(row["name"]),
            applied_at=str(row["applied_at"]),
            checksum=str(row["checksum"]),
            chkit_version=str(row["chkit_version"]),
            migration_completed=_parse_bool(row.get("migration_completed")),
            operations=_parse_operations(
                row.get("operations"), row.get(_FINGERPRINTS_COLUMN)
            ),
        )
        # Each request can land on a different replica, and SYSTEM SYNC REPLICA
        # on one request does not make the next one read our write. Never hand a
        # read-modify-write caller a version older than the one we just wrote,
        # or its write would drop the progress recorded in between.
        if written is not None and _row_version(state.applied_at) < _row_version(
            written.applied_at
        ):
            return written
        return state

    def write_migration_state(self, state: MigrationRowState) -> None:
        """Upsert one migration row with INSERT race retry (5 x backoff)."""
        # The release that wrote the state last. migrate checks a state another
        # release wrote before it resumes it, so the statement positions in a
        # state this release wrote are always this release's split (#562).
        if state.chkit_version != __version__:
            state = state.model_copy(update={"chkit_version": __version__})
        if self._database_missing:
            self._database_missing = False
            self._bootstrapped = False
        self._ensure_table(create=True)
        if self._database_missing:
            # Nothing to journal until the migration creates the database; the
            # INSERT would otherwise fall back to the server's default database.
            return
        self._ensure_fingerprint_column()
        self._insert_state(state, fingerprints=self._fingerprint_column)
        self._last_written[state.name] = state
        self._try_sync_replica()

    def _insert_state(self, state: MigrationRowState, *, fingerprints: bool) -> None:
        fingerprint_column = f", {_FINGERPRINTS_COLUMN}" if fingerprints else ""
        fingerprint_value = (
            f", {_fingerprints_array_literal(state.operations)}" if fingerprints else ""
        )
        sql = (
            f"INSERT INTO {self._qualified_table()} "
            f"(name, applied_at, checksum, chkit_version, "
            f"migration_completed, operations{fingerprint_column}) VALUES ("
            f"'{_escape_sql_string(state.name)}', "
            f"'{_escape_sql_string(state.applied_at)}', "
            f"'{_escape_sql_string(state.checksum)}', "
            f"'{_escape_sql_string(state.chkit_version)}', "
            f"{'true' if state.migration_completed else 'false'}, "
            f"{_operations_array_literal(state.operations)}"
            f"{fingerprint_value}"
            f")"
        )
        self._while_database_propagates(
            f"write to {self._table}", lambda: self._execute_insert(sql)
        )

    def _execute_insert(self, sql: str) -> None:
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
