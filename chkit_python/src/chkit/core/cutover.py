"""Zero-downtime cutover of a structural table change (``chkit generate --cutover``).

Port of TS ``packages/core/src/cutover.ts``. Writers keep inserting into the
table the whole time:

1. Create a shadow table with the new definition and a mirror materialized
   view ``FROM <table> TO <shadow>``, so every INSERT that starts from now on
   is written to both tables.
2. Wait until every INSERT that was already running has finished: those built
   their pipeline before the mirror existed and are not mirrored.
3. Snapshot the table's parts into a frozen copy (``ATTACH PARTITION ALL``,
   hard links) and wait for the INSERTs running at that moment, so every
   mirrored row of the snapshot has reached the shadow.
4. Copy the snapshot rows whose unique key is not in the shadow yet.
5. Verify per key that the shadow holds exactly the snapshot's rows.
6. ``EXCHANGE TABLES`` the table and the shadow, then drop the mirror.
7. Reconcile: an INSERT builds its pipeline a few names at a time, so one
   that starts at the instant of the swap can resolve the table before it and
   the rest after it. It then writes its rows only to the old table: once,
   without running any view, or twice, with the views having run (the mirror
   wrote the second copy back to the old table). Once no INSERT runs that
   could still do that, the rows of the old table whose key the new one lacks
   are added to it: rows held once by an INSERT, which runs the table's
   materialized views; rows held twice by ATTACH PARTITION from a staging
   table, which does not run them a second time.
8. The old table is kept as ``<table>_previous`` or dropped; the snapshot is
   dropped.

The unique key is the boundary between mirrored and copied rows, so the
cutover requires it: no INSERT may reuse a key that already exists.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Final, Literal, TypeAlias

from chkit.core.canonical import canonicalize_definition
from chkit.core.engine import engine_name
from chkit.core.kafka import is_kafka_engine
from chkit.core.key_clause import is_plain_column_reference
from chkit.core.model import (
    ChxValidationError,
    ColumnDefinition,
    MigrationOperation,
    SchemaDefinition,
    TableDefinition,
    TableRetainedBy,
    ValidationIssue,
)
from chkit.core.sql import to_create_sql

CutoverCopyMode: TypeAlias = Literal["migration", "backfill"]
CutoverOldTableMode: TypeAlias = Literal["keep", "drop"]

CUTOVER_COPY_MODES: Final[tuple[CutoverCopyMode, ...]] = ("migration", "backfill")
CUTOVER_OLD_TABLE_MODES: Final[tuple[CutoverOldTableMode, ...]] = ("keep", "drop")

_PLAIN_MERGE_TREE_ENGINES: Final = frozenset(
    {"MergeTree", "ReplicatedMergeTree", "SharedMergeTree"}
)
# Engines whose writers stream batches from a background thread, not from a
# query in system.processes, so the insert barrier cannot see them.
_STREAMING_ENGINES: Final = frozenset(
    {
        "Kafka",
        "RabbitMQ",
        "NATS",
        "FileLog",
        "S3Queue",
        "AzureQueue",
        "ObjectStorageQueue",
        "Redis",
    }
)
_COMMENT_PREFIX: Final = "chkit cutover "
_REPLICATED_PATH: Final = re.compile(r"^\s*\w+\s*\(\s*'((?:[^'\\]|\\.)*)'")
_NULLABLE: Final = re.compile(r"^\s*Nullable\s*\(")


@dataclass(frozen=True)
class CutoverRequest:
    database: str
    table: str
    # Columns that identify a row; no two rows ever share them.
    key: list[str]


@dataclass(frozen=True)
class CutoverOptions:
    copy: CutoverCopyMode
    old_table: CutoverOldTableMode
    # YYYYMMDDHHMMSS, makes the temporary object names unique per cutover.
    stamp: str
    # clickhouse.cluster: DDL runs ON CLUSTER and data steps run on every shard.
    cluster: str | None = None


@dataclass(frozen=True)
class CutoverNames:
    # Created with the new definition; after the swap it holds the old table.
    shadow: str
    mirror: str
    snapshot: str
    # Holds the rows the swap left behind in the old table, until they are
    # attached to the new one.
    reconcile: str
    # Final name of the old table with --cutover-old keep.
    previous: str


@dataclass(frozen=True)
class CutoverMetadata:
    """Stored as the snapshot table's comment; ``plugin backfill --cutover`` reads it."""

    database: str
    table: str
    shadow: str
    snapshot: str
    key: list[str]
    columns: list[str]


@dataclass(frozen=True)
class PlannedCutover:
    request: CutoverRequest
    options: CutoverOptions
    names: CutoverNames
    # Columns copied and mirrored: stored in the old table, insertable in the new one.
    columns: list[str]
    operations: list[MigrationOperation]
    # With --cutover-old keep, the old definition as <table>_previous.
    retained: TableDefinition | None


def cutover_names(table: str, stamp: str) -> CutoverNames:
    shadow = f"{table}__cutover_{stamp}"
    return CutoverNames(
        shadow=shadow,
        mirror=f"{shadow}_mirror",
        snapshot=f"{shadow}_snapshot",
        reconcile=f"{shadow}_reconcile",
        previous=f"{table}_previous",
    )


def parse_cutover_request(value: str) -> CutoverRequest:
    """Parses ``db.table=col[,col...]`` from ``--cutover``."""
    eq = value.find("=")
    target = (value if eq == -1 else value[:eq]).strip()
    key_part = "" if eq == -1 else value[eq + 1 :]
    dot = target.find(".")
    database = "" if dot == -1 else target[:dot].strip()
    table = "" if dot == -1 else target[dot + 1 :].strip()
    if not database or not table:
        msg = (
            f'Invalid --cutover "{value}". '
            "Expected <database>.<table>=<key column>[,<key column>...]."
        )
        raise ValueError(msg)
    key = [column.strip() for column in key_part.split(",") if column.strip()]
    if not key:
        msg = (
            f"--cutover {target} needs the columns that identify a row: "
            f"--cutover {target}=<column>[,<column>...]. "
            "A zero-downtime cutover tells copied rows from mirrored rows by that key, "
            "so no two rows may share it."
        )
        raise ValueError(msg)
    return CutoverRequest(database=database, table=table, key=key)


def format_cutover_metadata(metadata: CutoverMetadata) -> str:
    payload = {
        "chkitCutover": 1,
        "database": metadata.database,
        "table": metadata.table,
        "shadow": metadata.shadow,
        "snapshot": metadata.snapshot,
        "key": metadata.key,
        "columns": metadata.columns,
    }
    return _COMMENT_PREFIX + json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def parse_cutover_metadata(comment: str) -> CutoverMetadata | None:
    """Reads the metadata a cutover stores as its snapshot table's comment, if it is one."""
    if not comment.startswith(_COMMENT_PREFIX):
        return None
    try:
        parsed = json.loads(comment[len(_COMMENT_PREFIX) :])
    except ValueError:
        return None
    if not isinstance(parsed, dict) or parsed.get("chkitCutover") != 1:
        return None
    strings = ("database", "table", "shadow", "snapshot")
    if not all(isinstance(parsed.get(field), str) for field in strings):
        return None
    if not isinstance(parsed.get("key"), list) or not isinstance(parsed.get("columns"), list):
        return None
    return CutoverMetadata(
        database=parsed["database"],
        table=parsed["table"],
        shadow=parsed["shadow"],
        snapshot=parsed["snapshot"],
        key=[str(column) for column in parsed["key"]],
        columns=[str(column) for column in parsed["columns"]],
    )


def plan_cutover(
    *,
    old_def: TableDefinition,
    new_def: TableDefinition,
    request: CutoverRequest,
    options: CutoverOptions,
    definitions: list[SchemaDefinition],
) -> PlannedCutover:
    """Plans the cutover of ``request`` from ``old_def`` to ``new_def``.

    ``definitions`` is the full new schema, read for writers of the table the
    cutover cannot cover. Raises ``ChxValidationError`` (``cutover_unsupported``)
    when the change cannot be cut over safely.
    """
    old_canonical = _canonical_table(old_def)
    new_canonical = _canonical_table(new_def)
    names = cutover_names(request.table, options.stamp)
    columns = _assert_cutover_supported(
        old_def=old_canonical,
        new_def=new_canonical,
        request=request,
        options=options,
        definitions=definitions,
        names=names,
    )
    sql = _create_cutover_sql(
        database=request.database,
        table=request.table,
        names=names,
        columns=columns,
        key=request.key,
        cluster=options.cluster,
    )
    metadata = CutoverMetadata(
        database=request.database,
        table=request.table,
        shadow=names.shadow,
        snapshot=names.snapshot,
        key=list(request.key),
        columns=columns,
    )
    operations = _build_operations(
        old_def=old_canonical,
        new_def=new_canonical,
        request=request,
        options=options,
        names=names,
        sql=sql,
        metadata=metadata,
    )
    retained = (
        old_def.model_copy(
            update={
                "name": names.previous,
                "renamed_from": None,
                "retained_by": TableRetainedBy(cutover=f"{request.database}.{request.table}"),
            }
        )
        if options.old_table == "keep"
        else None
    )
    return PlannedCutover(
        request=request,
        options=options,
        names=names,
        columns=columns,
        operations=operations,
        retained=retained,
    )


def _op(
    type_: str,
    key: str,
    risk: str,
    sql: str,
    *,
    mode: str | None = None,
    before_retry: str | None = None,
    warning: str | None = None,
) -> MigrationOperation:
    return MigrationOperation.model_validate(
        {
            "type": type_,
            "key": key,
            "risk": risk,
            "sql": sql,
            "mode": mode,
            "beforeRetry": before_retry,
            "warning": warning,
        }
    )


def _build_operations(
    *,
    old_def: TableDefinition,
    new_def: TableDefinition,
    request: CutoverRequest,
    options: CutoverOptions,
    names: CutoverNames,
    sql: _CutoverSql,
    metadata: CutoverMetadata,
) -> list[MigrationOperation]:
    database = request.database
    table_key = f"table:{database}.{request.table}"

    def step_key(step: str) -> str:
        return f"{table_key}:cutover:{step}"

    shadow_def = _without_rename(new_def).model_copy(update={"name": names.shadow})
    snapshot_def = _without_rename(old_def).model_copy(
        update={"name": names.snapshot, "comment": format_cutover_metadata(metadata)}
    )
    operations = [
        _op("cutover_validate", step_key("start"), "caution", sql.validate_start),
        _op("create_table", f"table:{database}.{names.shadow}", "safe", to_create_sql(shadow_def)),
        _op(
            "create_materialized_view",
            f"materialized_view:{database}.{names.mirror}",
            "caution",
            sql.create_mirror,
            warning=(
                f"From here on every INSERT into {database}.{request.table} is also "
                f"written to {database}.{names.shadow}. No INSERT may reuse a key "
                f"({', '.join(request.key)}) that already exists, and no mutation "
                "(ALTER UPDATE/DELETE, lightweight DELETE, TRUNCATE, partition operations) "
                f"may run on {database}.{request.table} until the cutover migration completes."
            ),
        ),
        _op(
            "cutover_wait_for_inserts",
            step_key("mirror_barrier"),
            "safe",
            sql.insert_barrier,
            mode="barrier",
        ),
        _op(
            "create_table",
            f"table:{database}.{names.snapshot}",
            "safe",
            to_create_sql(snapshot_def),
        ),
        _op(
            "cutover_snapshot",
            step_key("snapshot"),
            "caution",
            sql.attach_snapshot,
            before_retry=sql.truncate_snapshot,
        ),
        _op(
            "cutover_wait_for_inserts",
            step_key("snapshot_barrier"),
            "safe",
            sql.insert_barrier,
            mode="barrier",
        ),
    ]

    # Replicated tables apply parts asynchronously on the other replicas: the
    # copy and the verification read whichever replica cluster() picks.
    def sync_replicas(step: str) -> list[MigrationOperation]:
        return [
            _op(
                "cutover_sync_replicas",
                step_key(f"{step}_{'snapshot' if index == 0 else 'shadow'}"),
                "safe",
                statement,
            )
            for index, statement in enumerate(sql.sync_replicas)
        ]

    operations.extend(sync_replicas("sync_before_copy"))
    if options.copy == "migration":
        operations.append(
            _op("cutover_copy", step_key("copy"), "caution", sql.copy, mode="async")
        )
        operations.extend(sync_replicas("sync_before_verify"))
    operations.extend(
        [
            _op(
                "cutover_verify",
                step_key("verify"),
                "caution",
                sql.verify_after_copy if options.copy == "migration" else sql.verify_backfill,
            ),
            _op(
                "cutover_validate",
                step_key("before_exchange"),
                "caution",
                sql.validate_before_exchange,
            ),
            _op(
                "exchange_tables",
                table_key,
                "caution",
                f"EXCHANGE TABLES {_qualified(database, request.table)} AND "
                f"{_qualified(database, names.shadow)};",
                before_retry=sql.unswapped_guard,
            ),
            _op(
                "drop_materialized_view",
                f"materialized_view:{database}.{names.mirror}",
                "caution",
                f"DROP TABLE IF EXISTS {_qualified(database, names.mirror)} SYNC;",
            ),
            _op(
                "cutover_validate",
                step_key("after_exchange"),
                "caution",
                sql.validate_after_exchange,
            ),
            _op(
                "cutover_wait_for_inserts",
                step_key("exchange_barrier"),
                "safe",
                sql.insert_barrier,
                mode="barrier",
            ),
            *(
                _op(
                    "cutover_sync_replicas",
                    step_key(f"sync_before_reconcile_{'old' if index == 0 else 'new'}"),
                    "safe",
                    statement,
                )
                for index, statement in enumerate(sql.sync_after_exchange)
            ),
            _op(
                "cutover_reconcile",
                step_key("reconcile_unmirrored"),
                "caution",
                sql.reconcile_unmirrored,
                mode="async",
            ),
            _op(
                "create_table",
                f"table:{database}.{names.reconcile}",
                "safe",
                to_create_sql(
                    _without_rename(new_def).model_copy(update={"name": names.reconcile})
                ),
            ),
            _op(
                "cutover_reconcile",
                step_key("reconcile"),
                "caution",
                sql.reconcile,
                mode="async",
                before_retry=sql.truncate_reconcile,
            ),
            _op(
                "cutover_attach",
                step_key("attach_reconciled"),
                "caution",
                sql.attach_reconciled,
                before_retry=sql.not_attached_guard,
            ),
            _op(
                "drop_table",
                f"table:{database}.{names.reconcile}",
                "caution",
                f"DROP TABLE IF EXISTS {_qualified(database, names.reconcile)} SYNC;",
            ),
        ]
    )
    if options.old_table == "keep":
        operations.append(
            _op(
                "alter_table_rename_table",
                f"table:{database}.{names.previous}:rename_table",
                "caution",
                f"RENAME TABLE IF EXISTS {_qualified(database, names.shadow)} TO "
                f"{_qualified(database, names.previous)};",
            )
        )
    else:
        operations.append(
            _op(
                "drop_table",
                f"table:{database}.{names.shadow}",
                "danger",
                f"DROP TABLE IF EXISTS {_qualified(database, names.shadow)} SYNC;",
                before_retry=sql.swapped_guard,
                warning=(
                    f"Drops the pre-cutover table {database}.{names.shadow} (the old "
                    f"{database}.{request.table}). Use --cutover-old keep to retain it as "
                    f"{database}.{names.previous}."
                ),
            )
        )
    operations.append(
        _op(
            "drop_table",
            f"table:{database}.{names.snapshot}",
            "caution",
            f"DROP TABLE IF EXISTS {_qualified(database, names.snapshot)} SYNC;",
        )
    )
    return operations


@dataclass(frozen=True)
class _CutoverSql:
    validate_start: str
    create_mirror: str
    insert_barrier: str
    attach_snapshot: str
    truncate_snapshot: str
    reconcile: str
    reconcile_unmirrored: str
    truncate_reconcile: str
    attach_reconciled: str
    not_attached_guard: str
    # Empty without a cluster.
    sync_after_exchange: list[str]
    # Empty without a cluster.
    sync_replicas: list[str]
    copy: str
    verify_after_copy: str
    verify_backfill: str
    validate_before_exchange: str
    unswapped_guard: str
    validate_after_exchange: str
    swapped_guard: str


def _create_cutover_sql(
    *,
    database: str,
    table: str,
    names: CutoverNames,
    columns: list[str],
    key: list[str],
    cluster: str | None,
) -> _CutoverSql:
    def q(name: str) -> str:
        return _qualified(database, name)

    target = f"{database}.{table}"
    column_list = ", ".join(_quote_column(column) for column in columns)
    key_list = ", ".join(_quote_column(column) for column in key)

    def every_replica(query: str) -> str:
        if cluster:
            return f"clusterAllReplicas({_string_literal(cluster)}, view({query}))"
        return f"({query})"

    def table_count(name: str) -> str:
        return (
            f"(SELECT count() FROM system.tables WHERE database = {_string_literal(database)} "
            f"AND name = {_string_literal(name)})"
        )

    def layout(name: str) -> str:
        return (
            "(SELECT any(tuple(engine, sorting_key, primary_key, partition_key)) "
            f"FROM system.tables WHERE database = {_string_literal(database)} "
            f"AND name = {_string_literal(name)})"
        )

    # Per replica: 1 when the condition holds. A guard throws unless every replica reports 1.
    def guard(condition: str, message: str) -> str:
        return (
            "SELECT throwIf(countIf(ok = 0) > 0 OR count() = 0, "
            f"{_string_literal(message)}) FROM "
            f"{every_replica(f'SELECT toUInt8({condition}) AS ok')}"
        )

    unswapped = (
        f"{table_count(table)} = 1 AND {table_count(names.snapshot)} = 1 AND "
        f"{table_count(names.shadow)} = 1 AND {layout(table)} = {layout(names.snapshot)} AND "
        f"{layout(names.shadow)} != {layout(names.snapshot)}"
    )
    swapped = (
        f"{table_count(names.shadow)} = 0 OR ({table_count(names.snapshot)} = 1 AND "
        f"{layout(names.shadow)} = {layout(names.snapshot)} AND "
        f"{layout(table)} != {layout(names.snapshot)})"
    )
    unswapped_guard = guard(
        unswapped,
        f"{target} no longer has its original layout next to {names.snapshot}: the "
        "EXCHANGE may already have run. Compare both tables in system.tables before you "
        "retry; never exchange them again blindly.",
    )
    pending_mutations = (
        f"(SELECT count() FROM system.mutations WHERE database = {_string_literal(database)} "
        f"AND table = {_string_literal(table)} AND NOT is_done)"
    )

    settings = "" if cluster else " SETTINGS select_sequential_consistency = 1"
    verify_query = " ".join(
        [
            "SELECT count() AS bad FROM (",
            f"SELECT {key_list}, sum(src) AS snapshot_rows, sum(1 - src) AS shadow_rows, "
            "sumIf(h, src = 1) AS snapshot_hash, sumIf(h, src = 0) AS shadow_hash",
            f"FROM (SELECT {key_list}, toUInt8(1) AS src, cityHash64({column_list}) AS h "
            f"FROM {q(names.snapshot)}",
            f"UNION ALL SELECT {key_list}, toUInt8(0) AS src, cityHash64({column_list}) AS h "
            f"FROM {q(names.shadow)})",
            f"GROUP BY {key_list} HAVING snapshot_rows > 0 AND "
            "(snapshot_rows != shadow_rows OR snapshot_hash != shadow_hash))",
        ]
    )

    def verify(message: str) -> str:
        if cluster:
            return (
                f"SELECT throwIf(sum(bad) > 0, {_string_literal(message)}) FROM "
                f"cluster({_string_literal(cluster)}, view({verify_query}));"
            )
        return (
            f"SELECT throwIf(bad > 0, {_string_literal(message)}) FROM ({verify_query})"
            f"{settings};"
        )

    if cluster:
        copy = "\n".join(
            [
                f"INSERT INTO FUNCTION cluster({_string_literal(cluster)}, "
                f"{_string_literal(database)}, {_string_literal(names.shadow)}) ({column_list})",
                f"SELECT {column_list} FROM cluster({_string_literal(cluster)}, "
                f"{_string_literal(database)}, {_string_literal(names.snapshot)})",
                f"WHERE ({key_list}) NOT IN (SELECT {key_list} FROM {q(names.shadow)})",
                "SETTINGS parallel_distributed_insert_select = 2, insert_deduplicate = 0;",
            ]
        )
    else:
        copy = "\n".join(
            [
                f"INSERT INTO {q(names.shadow)} ({column_list})",
                f"SELECT {column_list} FROM {q(names.snapshot)}",
                f"WHERE ({key_list}) NOT IN (SELECT {key_list} FROM {q(names.shadow)})",
                "SETTINGS insert_deduplicate = 0, select_sequential_consistency = 1;",
            ]
        )

    # Keys of the old table that the new one lacks. GROUP BY spills to disk on
    # a large table; the IN set only holds the few rows left behind.
    # ``copies`` tells the two straddles apart: one copy in the old table means
    # the INSERT ran no views (inserted again, so they run once); several mean
    # it ran them, mirrored into the old table (staged and attached).
    def missing_keys(copies: str) -> str:
        return (
            f"SELECT {key_list} FROM (SELECT {key_list}, toUInt8(1) AS old FROM "
            f"{q(names.shadow)} UNION ALL SELECT {key_list}, toUInt8(0) AS old FROM {q(table)}) "
            f"GROUP BY {key_list} HAVING min(old) = 1 AND sum(old) {copies}"
        )

    def copy_missing(into: str, copies: str) -> str:
        if cluster:
            return "\n".join(
                [
                    f"INSERT INTO FUNCTION cluster({_string_literal(cluster)}, "
                    f"{_string_literal(database)}, {_string_literal(into)}) ({column_list})",
                    f"SELECT {column_list} FROM cluster({_string_literal(cluster)}, "
                    f"{_string_literal(database)}, {_string_literal(names.shadow)})",
                    f"WHERE ({key_list}) IN ({missing_keys(copies)})",
                    f"LIMIT 1 BY {key_list}",
                    "SETTINGS parallel_distributed_insert_select = 2, insert_deduplicate = 0;",
                ]
            )
        return "\n".join(
            [
                f"INSERT INTO {q(into)} ({column_list})",
                f"SELECT {column_list} FROM {q(names.shadow)}",
                f"WHERE ({key_list}) IN ({missing_keys(copies)})",
                f"LIMIT 1 BY {key_list}",
                "SETTINGS insert_deduplicate = 0, select_sequential_consistency = 1;",
            ]
        )

    reconcile = copy_missing(names.reconcile, "> 1")
    reconcile_unmirrored = copy_missing(table, "= 1")
    attached_keys = (
        f"SELECT count() AS attached FROM {q(table)} WHERE ({key_list}) IN "
        f"(SELECT {key_list} FROM {q(names.reconcile)})"
    )
    attached_message = _string_literal(
        f"Rows of {names.reconcile} are already in {target}: the ATTACH may already have run. "
        "Inspect before you retry."
    )
    not_attached_guard = (
        f"SELECT throwIf(sum(attached) > 0, {attached_message}) FROM "
        f"cluster({_string_literal(cluster)}, view({attached_keys}))"
        if cluster
        else (
            f"SELECT throwIf(attached > 0, {attached_message}) FROM ({attached_keys}) "
            "SETTINGS select_sequential_consistency = 1"
        )
    )

    validate_start_query = " ".join(
        [
            f"SELECT (SELECT count() FROM system.databases WHERE name = "
            f"{_string_literal(database)} AND engine IN ('Atomic', 'Replicated')) AS atomic,",
            f"{table_count(table)} AS present,",
            f"{table_count(names.shadow)} + {table_count(names.mirror)} + "
            f"{table_count(names.snapshot)} + {table_count(names.reconcile)} AS leftovers,",
            f"{pending_mutations} AS mutations",
        ]
    )
    validate_start = "\n".join(
        [
            "SELECT",
            "  throwIf(min(atomic) = 0, "
            + _string_literal(
                f"Database {database} must use the Atomic or Replicated engine: "
                "EXCHANGE TABLES needs it."
            )
            + "),",
            "  throwIf(min(present) = 0, "
            + _string_literal(f"Table {target} does not exist.")
            + "),",
            "  throwIf(max(leftovers) > 0, "
            + _string_literal(
                f"Objects of an earlier attempt of this cutover exist ({names.shadow}, "
                f"{names.mirror}, {names.snapshot} or {names.reconcile}). Inspect and drop them "
                "before you run the migration again."
            )
            + "),",
            "  throwIf(max(mutations) > 0, "
            + _string_literal(
                f"{target} has unfinished mutations. Wait for them to finish: rows they "
                "change would not reach the new table."
            )
            + ")",
            f"FROM {every_replica(validate_start_query)};",
        ]
    )
    sync_replicas = (
        [
            f"SYSTEM SYNC REPLICA ON CLUSTER {_string_literal(cluster)} {q(name)} LIGHTWEIGHT;"
            for name in (names.snapshot, names.shadow)
        ]
        if cluster
        else []
    )
    return _CutoverSql(
        validate_start=validate_start,
        create_mirror=(
            f"CREATE MATERIALIZED VIEW IF NOT EXISTS {q(names.mirror)} TO {q(names.shadow)} AS\n"
            f"SELECT {column_list} FROM {q(table)};"
        ),
        insert_barrier=(
            "SELECT query_id FROM system.processes WHERE query_kind IN "
            "('Insert', 'AsyncInsertFlush');"
        ),
        attach_snapshot=f"ALTER TABLE {q(names.snapshot)} ATTACH PARTITION ALL FROM {q(table)};",
        truncate_snapshot=f"TRUNCATE TABLE IF EXISTS {q(names.snapshot)} SYNC",
        reconcile=reconcile,
        reconcile_unmirrored=reconcile_unmirrored,
        truncate_reconcile=f"TRUNCATE TABLE IF EXISTS {q(names.reconcile)} SYNC",
        attach_reconciled=(
            f"ALTER TABLE {q(table)} ATTACH PARTITION ALL FROM {q(names.reconcile)};"
        ),
        not_attached_guard=not_attached_guard,
        sync_after_exchange=(
            [
                f"SYSTEM SYNC REPLICA ON CLUSTER {_string_literal(cluster)} {q(name)} LIGHTWEIGHT;"
                for name in (names.shadow, table)
            ]
            if cluster
            else []
        ),
        sync_replicas=sync_replicas,
        copy=copy,
        verify_after_copy=verify(
            f"The copy into {database}.{names.shadow} does not match {names.snapshot}: a key "
            "was inserted again or the table was mutated during the cutover. The table was "
            "not swapped."
        ),
        verify_backfill=verify(
            f"{database}.{names.shadow} does not hold the rows of {names.snapshot} yet. Copy "
            f"them with: chkit plugin backfill plan --cutover {target} (then run or submit "
            "the plan), and run chkit migrate --apply again."
        ),
        validate_before_exchange=f"{unswapped_guard};",
        unswapped_guard=unswapped_guard,
        validate_after_exchange=guard(
            f"{table_count(names.shadow)} = 1 AND {table_count(names.snapshot)} = 1 AND "
            f"{layout(names.shadow)} = {layout(names.snapshot)} AND "
            f"{layout(table)} != {layout(names.snapshot)}",
            f"{target} does not have its new layout on every replica after the EXCHANGE. "
            "Inspect both tables before you continue.",
        )
        + ";",
        swapped_guard=guard(
            swapped,
            f"{database}.{names.shadow} is not the pre-cutover table on every replica, so it "
            "is not dropped. Inspect both tables before you retry.",
        ),
    )


def _assert_cutover_supported(  # noqa: PLR0912
    *,
    old_def: TableDefinition,
    new_def: TableDefinition,
    request: CutoverRequest,
    options: CutoverOptions,
    definitions: list[SchemaDefinition],
    names: CutoverNames,
) -> list[str]:
    target = f"{request.database}.{request.table}"
    problems: list[str] = []

    for side in (old_def, new_def):
        engine = engine_name(side.engine)
        if engine not in _PLAIN_MERGE_TREE_ENGINES:
            problems.append(
                f"engine {side.engine} is not supported: a cutover covers MergeTree, "
                "ReplicatedMergeTree and SharedMergeTree tables, whose rows are never merged "
                "away, so the copy can be verified row by row."
            )
        elif options.cluster and engine == "MergeTree":
            problems.append(
                f"engine {side.engine} with clickhouse.cluster: each node would hold "
                "its own data. Use ReplicatedMergeTree so one replica per shard can copy it."
            )
        path = _replicated_path(side.engine)
        if path is not None and "{uuid}" not in path and "{table}" not in path:
            problems.append(
                f"the replication path {path} names no {{table}} or {{uuid}} macro, so the "
                f"shadow table would register at the same path as {target}."
            )
        if side.unique_key:
            problems.append("a UNIQUE KEY table cannot be cut over.")

    layout_changed = (
        engine_name(old_def.engine) != engine_name(new_def.engine)
        or ",".join(old_def.order_by) != ",".join(new_def.order_by)
        or ",".join(old_def.primary_key) != ",".join(new_def.primary_key)
        or (old_def.partition_by or "") != (new_def.partition_by or "")
    )
    if not layout_changed:
        problems.append(
            "only the engine arguments change. The cutover tells the old table from the new "
            "one by engine name, sorting key, primary key and partition key, so at least one "
            "of them must change."
        )

    columns = _copied_columns(old_def, new_def, problems)
    old_columns = {column.name: column for column in old_def.columns}
    for name in request.key:
        column = old_columns.get(name)
        if column is None:
            problems.append(f"key column {name} does not exist in {target}.")
            continue
        if name not in columns:
            problems.append(
                f"key column {name} must be a stored column of both the old and the new table."
            )
            continue
        if column.nullable or _NULLABLE.match(column.type):
            problems.append(
                f"key column {name} is Nullable; NOT IN never matches NULL, so such rows could "
                "not be told apart."
            )

    for definition in definitions:
        if (
            options.old_table == "keep"
            and definition.kind == "table"
            and definition.database == request.database
            and definition.name == names.previous
        ):
            problems.append(
                f"{request.database}.{names.previous} already exists in the schema; the old "
                "table is kept under that name. Drop it first (chkit generate --drop-retained "
                f"{request.database}.{names.previous}) or use --cutover-old drop."
            )
        if (
            definition.kind != "materialized_view"
            or definition.to.database != request.database
            or definition.to.name != request.table
        ):
            continue
        if definition.refresh is not None:
            problems.append(
                f"refreshable materialized view {definition.database}.{definition.name} writes "
                f"into {target} outside any INSERT query, which the cutover cannot follow. "
                "Drop it for the cutover and recreate it afterwards."
            )
            continue
        source = _streaming_source(definition.as_, definitions, definition.database)
        if source:
            problems.append(
                f"materialized view {definition.database}.{definition.name} feeds {target} "
                f"from the {source} table, whose consumer is invisible to the insert barrier. "
                "Detach the consumer view for the cutover and attach it afterwards."
            )

    if options.copy == "backfill" and options.cluster:
        problems.append(
            "--cutover-copy backfill is not supported with clickhouse.cluster: the backfill "
            "plugin plans chunks from one node. Use --cutover-copy migration, which copies "
            "on every shard."
        )

    if problems:
        raise ChxValidationError(
            [
                ValidationIssue(
                    code="cutover_unsupported",
                    kind="table",
                    database=request.database,
                    name=request.table,
                    message=f"Cannot cut over {target}: {problem}",
                )
                for problem in problems
            ]
        )
    return columns


def _copied_columns(
    old_def: TableDefinition, new_def: TableDefinition, problems: list[str]
) -> list[str]:
    """Stored in the old table and insertable in the new one; a type change is refused."""
    new_columns = {column.name: column for column in new_def.columns}
    columns: list[str] = []
    for old_column in old_def.columns:
        new_column = new_columns.get(old_column.name)
        if new_column is None:
            continue
        if not _is_stored(old_column) or not _is_insertable(new_column):
            continue
        if _column_type(old_column) != _column_type(new_column):
            problems.append(
                f"column {old_column.name} changes type ({_column_type(old_column)} to "
                f"{_column_type(new_column)}). Change column types in a separate migration."
            )
            continue
        columns.append(old_column.name)
    return columns


def _is_stored(column: ColumnDefinition) -> bool:
    return column.default_kind not in ("ALIAS", "EPHEMERAL")


def _is_insertable(column: ColumnDefinition) -> bool:
    return column.default_kind in (None, "DEFAULT")


def _column_type(column: ColumnDefinition) -> str:
    type_ = str(column.type).strip()
    return f"Nullable({type_})" if column.nullable else type_


def _replicated_path(engine: str) -> str | None:
    """The first argument of a Replicated*MergeTree engine with explicit arguments."""
    if not engine_name(engine).startswith("Replicated"):
        return None
    match = _REPLICATED_PATH.match(engine)
    return match.group(1) if match else None


def _streaming_source(
    query: str, definitions: list[SchemaDefinition], default_database: str
) -> str | None:
    for definition in definitions:
        if definition.kind != "table":
            continue
        engine = engine_name(definition.engine)
        if engine not in _STREAMING_ENGINES and not is_kafka_engine(definition.engine):
            continue
        qualified = re.compile(
            rf"\b{re.escape(definition.database)}\s*\.\s*`?{re.escape(definition.name)}\b"
        )
        bare = (
            re.compile(rf"\bFROM\s+`?{re.escape(definition.name)}\b", re.IGNORECASE)
            if definition.database == default_database
            else None
        )
        if qualified.search(query) or (bare is not None and bare.search(query)):
            return f"{definition.database}.{definition.name} ({engine})"
    return None


def _canonical_table(definition: TableDefinition) -> TableDefinition:
    canonical = canonicalize_definition(definition)
    if not isinstance(canonical, TableDefinition):
        msg = f"Expected a table definition for {definition.database}.{definition.name}."
        raise TypeError(msg)
    return canonical


def _without_rename(definition: TableDefinition) -> TableDefinition:
    return definition.model_copy(update={"renamed_from": None, "retained_by": None})


def _qualified(database: str, name: str) -> str:
    """TS ``renderQualifiedName``: plain identifiers bare, anything else quoted."""
    return f"{_render_identifier(database)}.{_render_identifier(name)}"


def _render_identifier(name: str) -> str:
    return name if is_plain_column_reference(name) else _quote_column(name)


def _quote_column(name: str) -> str:
    escaped = name.replace("\\", "\\\\").replace("`", "\\`")
    return f"`{escaped}`"


def _string_literal(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


__all__ = [
    "CUTOVER_COPY_MODES",
    "CUTOVER_OLD_TABLE_MODES",
    "CutoverCopyMode",
    "CutoverMetadata",
    "CutoverNames",
    "CutoverOldTableMode",
    "CutoverOptions",
    "CutoverRequest",
    "PlannedCutover",
    "cutover_names",
    "format_cutover_metadata",
    "parse_cutover_metadata",
    "parse_cutover_request",
    "plan_cutover",
]
