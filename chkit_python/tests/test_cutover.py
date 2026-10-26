"""Zero-downtime cutover (``generate --cutover``, #202).

Ports of the TS ``packages/core/src/cutover.test.ts``,
``packages/cli/src/test/commands/generate/cutover.test.ts``, the cutover cases
of ``codegen/src/index.test.ts``, ``runtime/safety-markers.test.ts``,
``commands/migrate/apply-resume.test.ts``,
``packages/clickhouse/src/insert-barrier.test.ts`` and the cutover chunk SQL
case of ``plugin-backfill/src/chunking/sql.test.ts``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from chkit.cli.commands import migrate_apply
from chkit.cli.commands.generate_cutover import (
    apply_cutovers,
    carry_retained_definitions,
    resolve_cutover_flags,
    summarize_cutover,
)
from chkit.cli.commands.migrate_apply import ApplyMigrationInput, apply_migration
from chkit.cli.journal_store import MigrationRowState, OperationState
from chkit.cli.migration_store import (
    MigrationJournalEntry,
    _build_migration_content,
    checksum_sql,
)
from chkit.cli.safety_markers import extract_migration_operation_summaries
from chkit.clickhouse import ddl_propagation
from chkit.clickhouse.ddl_propagation import parse_exchange_tables, wait_for_exchange
from chkit.clickhouse.insert_barrier import wait_for_insert_barrier
from chkit.clickhouse.replicas import ReplicaFanout
from chkit.core.cutover import (
    CutoverMetadata,
    CutoverOptions,
    CutoverRequest,
    PlannedCutover,
    cutover_names,
    format_cutover_metadata,
    parse_cutover_metadata,
    parse_cutover_request,
    plan_cutover,
    reads_table,
)
from chkit.core.model import (
    ChxValidationError,
    ColumnDefinition,
    MigrationPlan,
    SchemaDefinition,
    TableConstraintDefinition,
    TableDefinition,
    TableRenamedFrom,
    TableRetainedBy,
    materialized_view,
    table,
    view,
)
from chkit.core.on_cluster import apply_on_cluster_to_plan
from chkit.core.planner import plan_diff
from chkit_plugin_backfill.chunking.sql import build_chunk_execution_sql
from chkit_plugin_backfill.chunking.types import Chunk, TableProfile

COLUMNS: list[Any] = [
    {"name": "id", "type": "UInt64"},
    {"name": "user_id", "type": "UInt64"},
    {"name": "payload", "type": "String"},
]


def events(
    order_by: list[str] | None = None,
    *,
    name: str = "events",
    engine: str = "MergeTree",
    columns: list[Any] | None = None,
) -> TableDefinition:
    order = order_by or ["id"]
    return table(
        database="app",
        name=name,
        engine=engine,
        columns=columns or COLUMNS,
        primaryKey=order,
        orderBy=order,
    )


OLD = events(["id"])
NEW = events(["user_id", "id"])
STAMP = "20261024120000"


def plan(
    *,
    old_def: TableDefinition | None = None,
    new_def: TableDefinition | None = None,
    copy: str = "migration",
    old_table: str = "keep",
    cluster: str | None = None,
    key: list[str] | None = None,
    definitions: list[SchemaDefinition] | None = None,
) -> PlannedCutover:
    new = new_def or NEW
    return plan_cutover(
        old_def=old_def or OLD,
        new_def=new,
        request=CutoverRequest(database="app", table="events", key=key or ["id"]),
        options=CutoverOptions(
            copy=copy,  # type: ignore[arg-type]
            old_table=old_table,  # type: ignore[arg-type]
            cluster=cluster,
            stamp=STAMP,
        ),
        definitions=definitions if definitions is not None else [new],
    )


def messages(**kwargs: Any) -> list[str]:
    with pytest.raises(ChxValidationError) as info:
        plan(**kwargs)
    assert {issue.code for issue in info.value.issues} == {"cutover_unsupported"}
    return [issue.message for issue in info.value.issues]


# ---------- request / metadata ----------


def test_parse_cutover_request_reads_table_and_key() -> None:
    assert parse_cutover_request("app.events=id") == CutoverRequest("app", "events", ["id"])
    assert parse_cutover_request(" app.events = user_id, id ") == CutoverRequest(
        "app", "events", ["user_id", "id"]
    )


def test_parse_cutover_request_requires_a_key_and_a_qualified_table() -> None:
    with pytest.raises(ValueError, match=re.escape("--cutover app.events needs the columns")):
        parse_cutover_request("app.events")
    with pytest.raises(ValueError, match="needs the columns that identify a row"):
        parse_cutover_request("app.events=")
    with pytest.raises(ValueError, match=r"Expected <database>\.<table>=<key column>"):
        parse_cutover_request("events=id")


def test_cutover_metadata_round_trips_through_the_comment() -> None:
    metadata = CutoverMetadata(
        database="app",
        table="events",
        shadow="events__cutover_1",
        snapshot="events__cutover_1_snapshot",
        key=["id"],
        columns=["id", "payload"],
    )
    comment = format_cutover_metadata(metadata)
    assert comment.startswith('chkit cutover {"chkitCutover":1,"database":"app","table":"events"')
    assert parse_cutover_metadata(comment) == metadata
    assert parse_cutover_metadata("events table") is None
    assert parse_cutover_metadata('chkit cutover {"chkitCutover":2}') is None
    assert parse_cutover_metadata("chkit cutover not json") is None


# ---------- plan_cutover ----------


def test_names_temporary_objects_after_the_table_and_stamp() -> None:
    names = cutover_names("events", STAMP)
    assert (names.shadow, names.mirror, names.snapshot, names.reconcile, names.previous) == (
        "events__cutover_20261024120000",
        "events__cutover_20261024120000_mirror",
        "events__cutover_20261024120000_snapshot",
        "events__cutover_20261024120000_reconcile",
        "events_previous",
    )


def test_mirrors_snapshots_copies_verifies_and_swaps_in_order() -> None:
    ops = plan().operations
    assert [(op.type, op.key, op.risk, op.mode or "sync") for op in ops] == [
        ("cutover_validate", "table:app.events:cutover:start", "caution", "sync"),
        ("create_table", "table:app.events__cutover_20261024120000", "safe", "sync"),
        (
            "create_materialized_view",
            "materialized_view:app.events__cutover_20261024120000_mirror",
            "caution",
            "sync",
        ),
        ("cutover_wait_for_inserts", "table:app.events:cutover:mirror_barrier", "safe", "barrier"),
        ("create_table", "table:app.events__cutover_20261024120000_snapshot", "safe", "sync"),
        ("cutover_snapshot", "table:app.events:cutover:snapshot", "caution", "sync"),
        ("cutover_wait_for_inserts", "table:app.events:cutover:snapshot_barrier", "safe", "barrier"),
        ("cutover_copy", "table:app.events:cutover:copy", "caution", "async"),
        ("cutover_verify", "table:app.events:cutover:verify", "caution", "sync"),
        ("cutover_validate", "table:app.events:cutover:before_exchange", "caution", "sync"),
        ("exchange_tables", "table:app.events", "caution", "sync"),
        (
            "drop_materialized_view",
            "materialized_view:app.events__cutover_20261024120000_mirror",
            "caution",
            "sync",
        ),
        ("cutover_validate", "table:app.events:cutover:after_exchange", "caution", "sync"),
        ("cutover_wait_for_inserts", "table:app.events:cutover:exchange_barrier", "safe", "barrier"),
        ("cutover_reconcile", "table:app.events:cutover:reconcile_unmirrored", "caution", "async"),
        ("create_table", "table:app.events__cutover_20261024120000_reconcile", "safe", "sync"),
        ("cutover_reconcile", "table:app.events:cutover:reconcile", "caution", "async"),
        ("cutover_attach", "table:app.events:cutover:attach_reconciled", "caution", "sync"),
        ("drop_table", "table:app.events__cutover_20261024120000_reconcile", "caution", "sync"),
        ("alter_table_rename_table", "table:app.events_previous:rename_table", "caution", "sync"),
        ("drop_table", "table:app.events__cutover_20261024120000_snapshot", "caution", "sync"),
    ]


def test_shadow_has_new_layout_and_snapshot_old_layout_with_metadata() -> None:
    ops = plan().operations
    assert "CREATE TABLE IF NOT EXISTS app.events__cutover_20261024120000" in ops[1].sql
    assert "ORDER BY (`user_id`, `id`)" in ops[1].sql
    assert "CREATE TABLE IF NOT EXISTS app.events__cutover_20261024120000_snapshot" in ops[4].sql
    assert "ORDER BY (`id`)" in ops[4].sql
    assert 'COMMENT \'chkit cutover {"chkitCutover":1,"database":"app","table":"events"' in ops[4].sql


def test_mirror_and_copy_sql() -> None:
    ops = plan().operations
    assert ops[2].sql == (
        "CREATE MATERIALIZED VIEW IF NOT EXISTS app.events__cutover_20261024120000_mirror "
        "TO app.events__cutover_20261024120000 AS\n"
        "SELECT `id`, `user_id`, `payload` FROM app.events;"
    )
    assert ops[2].warning is not None
    assert "No INSERT may reuse a key (id)" in ops[2].warning
    assert ops[3].sql == (
        "SELECT query_id FROM system.processes WHERE query_kind IN ('Insert', 'AsyncInsertFlush');"
    )
    assert ops[5].sql == (
        "ALTER TABLE app.events__cutover_20261024120000_snapshot ATTACH PARTITION ALL FROM app.events;"
    )
    assert ops[5].before_retry == (
        "TRUNCATE TABLE IF EXISTS app.events__cutover_20261024120000_snapshot SYNC"
    )
    assert ops[7].sql == "\n".join(
        [
            "INSERT INTO app.events__cutover_20261024120000 (`id`, `user_id`, `payload`)",
            "SELECT `id`, `user_id`, `payload` FROM app.events__cutover_20261024120000_snapshot",
            "WHERE (`id`) NOT IN (SELECT `id` FROM app.events__cutover_20261024120000)",
            "SETTINGS insert_deduplicate = 0, select_sequential_consistency = 1;",
        ]
    )


def test_verify_compares_rows_per_key() -> None:
    verify = plan().operations[8].sql
    # A tuple, because cityHash64 of a NULL argument is NULL and sumIf skips NULLs.
    assert "cityHash64(tuple(`id`, `user_id`, `payload`))" in verify
    assert (
        "GROUP BY `id` HAVING snapshot_rows > 0 AND "
        "(snapshot_rows != shadow_rows OR snapshot_hash != shadow_hash)"
    ) in verify
    assert "The table was not swapped." in verify


def test_exchange_is_guarded_on_every_attempt() -> None:
    ops = plan().operations
    exchange = ops[10]
    assert exchange.sql == "EXCHANGE TABLES app.events AND app.events__cutover_20261024120000;"
    assert exchange.before_retry is not None
    assert f"{exchange.before_retry};" == ops[9].sql
    assert "\n" not in exchange.before_retry
    assert (
        "(SELECT any(tuple(engine, sorting_key, primary_key, partition_key)) FROM system.tables "
        "WHERE database = 'app' AND name = 'events') = (SELECT any(tuple(engine, sorting_key, "
        "primary_key, partition_key)) FROM system.tables WHERE database = 'app' AND "
        "name = 'events__cutover_20261024120000_snapshot')"
    ) in exchange.before_retry


# An INSERT that resolved the table before the swap and the mirror's target
# after it wrote its rows to the old table only: they are attached to the new
# table, which does not run its materialized views again.
def test_reconciles_rows_the_swap_left_in_the_old_table() -> None:
    by_key = {op.key: op for op in plan().operations}
    ops = {op.type: op for op in plan().operations}

    def missing(copies: str) -> str:
        return (
            "WHERE (`id`) IN (SELECT `id` FROM (SELECT `id`, toUInt8(1) AS old FROM "
            "app.events__cutover_20261024120000 UNION ALL SELECT `id`, toUInt8(0) AS old FROM "
            f"app.events) GROUP BY `id` HAVING min(old) = 1 AND sum(old) {copies})"
        )

    # Rows the old table holds once never ran the views: INSERT them.
    unmirrored = by_key["table:app.events:cutover:reconcile_unmirrored"]
    assert unmirrored.sql == "\n".join(
        [
            "INSERT INTO app.events (`id`, `user_id`, `payload`)",
            "SELECT `id`, `user_id`, `payload` FROM app.events__cutover_20261024120000",
            missing("= 1"),
            "LIMIT 1 BY `id`",
            "SETTINGS insert_deduplicate = 0, select_sequential_consistency = 1;",
        ]
    )
    assert unmirrored.before_retry is None
    # Rows it holds twice did: attach them through the staging table.
    staged = by_key["table:app.events:cutover:reconcile"]
    assert staged.sql == "\n".join(
        [
            "INSERT INTO app.events__cutover_20261024120000_reconcile (`id`, `user_id`, `payload`)",
            "SELECT `id`, `user_id`, `payload` FROM app.events__cutover_20261024120000",
            missing("> 1"),
            "LIMIT 1 BY `id`",
            "SETTINGS insert_deduplicate = 0, select_sequential_consistency = 1;",
        ]
    )
    assert staged.before_retry == (
        "TRUNCATE TABLE IF EXISTS app.events__cutover_20261024120000_reconcile SYNC"
    )
    assert ops["cutover_attach"].sql == (
        "ALTER TABLE app.events ATTACH PARTITION ALL FROM app.events__cutover_20261024120000_reconcile;"
    )
    assert ops["cutover_attach"].before_retry is not None
    assert "the ATTACH may already have run" in ops["cutover_attach"].before_retry


def test_keep_mode_renames_the_old_table_and_retains_it() -> None:
    cutover = plan()
    assert cutover.operations[19].sql == (
        "RENAME TABLE IF EXISTS app.events__cutover_20261024120000 TO app.events_previous;"
    )
    assert cutover.retained is not None
    assert cutover.retained.name == "events_previous"
    assert cutover.retained.order_by == ["id"]
    assert cutover.retained.retained_by is not None
    assert cutover.retained.retained_by.cutover == "app.events"


def test_drop_mode_drops_the_old_table_as_a_guarded_destructive_step() -> None:
    cutover = plan(old_table="drop")
    drop = next(
        op
        for op in cutover.operations
        if op.type == "drop_table" and op.key == "table:app.events__cutover_20261024120000"
    )
    assert cutover.retained is None
    assert not any(op.type == "alter_table_rename_table" for op in cutover.operations)
    assert drop.risk == "danger"
    assert drop.sql == "DROP TABLE IF EXISTS app.events__cutover_20261024120000 SYNC;"
    assert drop.before_retry is not None
    assert "is not the pre-cutover table on every replica" in drop.before_retry


def test_backfill_mode_leaves_the_copy_to_the_plugin() -> None:
    ops = plan(copy="backfill").operations
    assert not any(op.type == "cutover_copy" for op in ops)
    verify = next(op for op in ops if op.type == "cutover_verify")
    assert "chkit plugin backfill plan --cutover app.events" in verify.sql


def test_copies_columns_stored_in_old_and_insertable_in_new() -> None:
    old_def = events(
        ["id"],
        columns=[
            *COLUMNS,
            {"name": "dropped", "type": "String"},
            {"name": "day", "type": "Date", "defaultKind": "MATERIALIZED", "default": "fn:today()"},
        ],
    )
    new_def = events(
        ["user_id", "id"],
        columns=[
            *COLUMNS,
            {"name": "day", "type": "Date"},
            {"name": "added", "type": "String", "default": "x"},
        ],
    )
    assert plan(old_def=old_def, new_def=new_def).columns == ["id", "user_id", "payload", "day"]


def test_cluster_runs_data_steps_on_every_shard() -> None:
    engine = "ReplicatedMergeTree"
    cutover = plan(
        old_def=events(["id"], engine=engine),
        new_def=events(["user_id", "id"], engine=engine),
        cluster="c2",
    )
    ops = apply_on_cluster_to_plan(
        MigrationPlan.model_validate(
            {"operations": cutover.operations, "riskSummary": {}, "renameSuggestions": []}
        ),
        "c2",
    ).operations

    def sql_of(type_: str) -> list[str]:
        return [op.sql for op in ops if op.type == type_]

    assert sql_of("cutover_copy")[0] == "\n".join(
        [
            "INSERT INTO FUNCTION cluster('c2', 'app', 'events__cutover_20261024120000') "
            "(`id`, `user_id`, `payload`)",
            "SELECT `id`, `user_id`, `payload` FROM cluster('c2', 'app', "
            "'events__cutover_20261024120000_snapshot')",
            "WHERE (`id`) NOT IN (SELECT `id` FROM app.events__cutover_20261024120000)",
            "SETTINGS parallel_distributed_insert_select = 2, insert_deduplicate = 0;",
        ]
    )
    sync = [
        "SYSTEM SYNC REPLICA ON CLUSTER 'c2' app.events__cutover_20261024120000_snapshot LIGHTWEIGHT;",
        "SYSTEM SYNC REPLICA ON CLUSTER 'c2' app.events__cutover_20261024120000 LIGHTWEIGHT;",
    ]
    assert sql_of("cutover_sync_replicas") == [
        *sync,
        *sync,
        "SYSTEM SYNC REPLICA ON CLUSTER 'c2' app.events__cutover_20261024120000 LIGHTWEIGHT;",
        "SYSTEM SYNC REPLICA ON CLUSTER 'c2' app.events LIGHTWEIGHT;",
    ]
    assert "INSERT INTO FUNCTION cluster('c2', 'app', 'events') (" in sql_of("cutover_reconcile")[0]
    assert (
        "INSERT INTO FUNCTION cluster('c2', 'app', 'events__cutover_20261024120000_reconcile')"
        in sql_of("cutover_reconcile")[1]
    )
    assert sql_of("cutover_attach") == [
        "ALTER TABLE app.events ON CLUSTER 'c2' ATTACH PARTITION ALL FROM "
        "app.events__cutover_20261024120000_reconcile;"
    ]
    assert sql_of("cutover_verify")[0].startswith("SELECT throwIf(sum(bad) > 0, ")
    assert "FROM cluster('c2', view(SELECT count() AS bad" in sql_of("cutover_verify")[0]
    assert sql_of("exchange_tables") == [
        "EXCHANGE TABLES app.events AND app.events__cutover_20261024120000 ON CLUSTER 'c2';"
    ]
    assert "FROM clusterAllReplicas('c2', view(SELECT toUInt8(" in sql_of("cutover_validate")[1]
    snapshot = next(op for op in ops if op.type == "cutover_snapshot")
    assert snapshot.sql == (
        "ALTER TABLE app.events__cutover_20261024120000_snapshot ON CLUSTER 'c2' "
        "ATTACH PARTITION ALL FROM app.events;"
    )
    assert snapshot.before_retry == (
        "TRUNCATE TABLE IF EXISTS app.events__cutover_20261024120000_snapshot ON CLUSTER 'c2' SYNC"
    )


# ---------- refusals ----------


def test_refuses_engines_that_merge_rows_away() -> None:
    new_def = events(["user_id", "id"], engine="ReplacingMergeTree")
    assert messages(new_def=new_def) == [
        "Cannot cut over app.events: engine ReplacingMergeTree() is not supported: a cutover "
        "covers MergeTree, ReplicatedMergeTree and SharedMergeTree tables, whose rows are never "
        "merged away, so the copy can be verified row by row."
    ]


def test_refuses_missing_or_nullable_keys() -> None:
    assert "key column nope does not exist" in messages(key=["nope"])[0]
    nullable: list[Any] = [{"name": "id", "type": "UInt64", "nullable": True}, *COLUMNS[1:]]
    found = messages(
        old_def=events(["id"], columns=nullable),
        new_def=events(["user_id"], columns=nullable),
    )
    assert len(found) == 1
    assert "key column id is Nullable" in found[0]


def test_refuses_a_column_type_change() -> None:
    columns: list[Any] = [*COLUMNS[:2], {"name": "payload", "type": "LowCardinality(String)"}]
    found = messages(new_def=events(["user_id", "id"], columns=columns))
    assert len(found) == 1
    assert "column payload changes type" in found[0]


def test_refuses_an_engine_argument_only_change() -> None:
    found = messages(
        old_def=events(["id"], engine="ReplicatedMergeTree('/t/{uuid}', '{replica}')"),
        new_def=events(["id"], engine="ReplicatedMergeTree('/t2/{uuid}', '{replica}')"),
        cluster="c2",
    )
    assert len(found) == 1
    assert "only the engine arguments change" in found[0]


def test_refuses_a_replication_path_without_a_macro() -> None:
    engine = "ReplicatedMergeTree('/clickhouse/tables/{shard}/app/events', '{replica}')"
    found = messages(
        old_def=events(["id"], engine=engine),
        new_def=events(["user_id", "id"], engine=engine),
        cluster="c2",
    )
    assert len(found) == 2
    assert all("names no {table} or {uuid} macro" in message for message in found)


def test_refuses_plain_merge_tree_and_backfill_on_a_cluster() -> None:
    found = messages(cluster="c2", copy="backfill")
    assert len(found) == 3
    assert "engine MergeTree() with clickhouse.cluster" in found[0]
    assert "engine MergeTree() with clickhouse.cluster" in found[1]
    assert "--cutover-copy backfill is not supported with clickhouse.cluster" in found[2]


def test_refuses_a_replicated_table_without_a_cluster() -> None:
    engine = "ReplicatedMergeTree('/clickhouse/tables/{uuid}', '{replica}')"
    found = messages(
        old_def=events(["id"], engine=engine), new_def=events(["user_id", "id"], engine=engine)
    )
    assert len(found) == 2
    assert all(
        f"engine {engine} without clickhouse.cluster: the shadow table would exist on one "
        "replica only. Set clickhouse.cluster so every statement runs ON CLUSTER." in message
        for message in found
    )


def test_refuses_a_ttl_on_the_old_or_the_new_table() -> None:
    ttl = "toDateTime(id) + INTERVAL 1 DAY"
    expected = (
        f"Cannot cut over app.events: TTL {ttl} deletes rows in the background, at different "
        "times in the old and the new table, so the copy cannot be verified and the reconcile "
        "would insert expired rows again. Remove the TTL for the cutover and add it back in a "
        "separate migration."
    )
    assert messages(new_def=NEW.model_copy(update={"ttl": ttl})) == [expected]
    assert messages(old_def=OLD.model_copy(update={"ttl": ttl})) == [expected]


def test_refuses_a_rename_of_the_table_or_of_a_column() -> None:
    renamed_table = NEW.model_copy(update={"renamed_from": TableRenamedFrom(name="old_events")})
    assert messages(new_def=renamed_table) == [
        "Cannot cut over app.events: the table is also renamed. Rename it in a separate migration."
    ]
    body = ColumnDefinition.model_validate({"name": "body", "type": "String", "renamedFrom": "payload"})
    renamed_column = NEW.model_copy(update={"columns": [*NEW.columns[:2], body]})
    assert messages(new_def=renamed_column) == [
        "Cannot cut over app.events: column payload is renamed to body: the copy matches columns "
        "by name and would leave body empty. Rename the column in a separate migration."
    ]


def test_refuses_a_new_check_constraint() -> None:
    check = TableConstraintDefinition(name="positive", check="user_id > 0")
    assert messages(new_def=NEW.model_copy(update={"constraints": [check]})) == [
        "Cannot cut over app.events: CHECK constraint positive is new: rows the old table accepts "
        "would fail the mirror, and with it the writers' INSERTs. Add the constraint in a "
        "separate migration."
    ]
    # Unchanged CHECK constraints and ASSUME constraints are fine.
    assert plan(
        old_def=OLD.model_copy(update={"constraints": [check]}),
        new_def=NEW.model_copy(update={"constraints": [check]}),
    ).operations
    assume = TableConstraintDefinition(name="hint", assume="user_id > 0")
    assert plan(new_def=NEW.model_copy(update={"constraints": [assume]})).operations


def test_refuses_a_buffer_table_and_a_streaming_source_behind_an_intermediate_table() -> None:
    buffer = table(
        database="app",
        name="events_buffer",
        engine="Buffer('app', 'events', 16, 10, 100, 10000, 1000000, 10000000, 100000000)",
        columns=COLUMNS,
    )
    queue = table(
        database="app",
        name="events_queue",
        engine="Kafka('broker:9092', 'events', 'g', 'JSONEachRow')",
        columns=COLUMNS,
    )
    landing = table(database="app", name="events_landing", engine="Null", columns=COLUMNS)
    to_landing = materialized_view(
        database="app",
        name="queue_to_landing",
        to={"database": "app", "name": "events_landing"},
        as_="SELECT id, user_id, payload FROM app.events_queue",
    )
    to_events = materialized_view(
        database="app",
        name="landing_to_events",
        to={"database": "app", "name": "events"},
        as_="SELECT id, user_id, payload FROM app.events_landing",
    )
    found = messages(definitions=[NEW, buffer, queue, landing, to_landing, to_events])
    assert found == [
        "Cannot cut over app.events: Buffer table app.events_buffer flushes into app.events from "
        "a background thread, which the insert barrier cannot see. Drop it for the cutover and "
        "recreate it afterwards.",
        "Cannot cut over app.events: materialized view app.landing_to_events feeds app.events "
        "from the app.events_queue (Kafka) table, whose consumer is invisible to the insert "
        "barrier. Detach the consumer view for the cutover and attach it afterwards.",
    ]
    # A Buffer table into another table is fine.
    other = buffer.model_copy(
        update={"engine": "Buffer(app, other, 16, 10, 100, 10000, 1000000, 10000000, 100000000)"}
    )
    assert plan(definitions=[NEW, other]).operations
    # Quoted arguments match too.
    quoted = buffer.model_copy(
        update={"engine": 'Buffer(`app`, "events", 16, 10, 100, 10000, 1000000, 10000000, 100000000)'}
    )
    assert len(messages(definitions=[NEW, quoted])) == 1


def test_validate_start_explains_leftovers_of_an_earlier_attempt() -> None:
    validate = plan().operations[0].sql
    assert (
        "If the tables were already swapped, events__cutover_20261024120000 is the pre-cutover "
        "table and may hold rows not yet reconciled into events: do not drop it. Inspect them "
        "before you run the migration again."
    ) in validate


def test_reads_table_matches_qualified_and_bare_reads() -> None:
    assert reads_table("SELECT * FROM app.events", ("app", "events"), "other")
    assert reads_table("SELECT * FROM app . `events`", ("app", "events"), "other")
    assert reads_table("select * from events", ("app", "events"), "app")
    assert not reads_table("select * from events", ("app", "events"), "other")
    assert not reads_table("SELECT * FROM app.events_queue", ("app", "events"), "app")


def test_refuses_invisible_writers_and_a_taken_previous_name() -> None:
    queue = table(
        database="app",
        name="events_queue",
        engine="Kafka('broker:9092', 'events', 'g', 'JSONEachRow')",
        columns=COLUMNS,
    )
    consumer = materialized_view(
        database="app",
        name="events_consumer",
        to={"database": "app", "name": "events"},
        as_="SELECT id, user_id, payload FROM app.events_queue",
    )
    refresher = materialized_view(
        database="app",
        name="events_refresh",
        to={"database": "app", "name": "events"},
        as_="SELECT 1 AS id",
        refresh={"every": "1 HOUR", "append": True},
    )
    previous = events(["id"], name="events_previous")
    found = messages(definitions=[NEW, queue, consumer, refresher, previous])
    assert len(found) == 3
    assert "materialized view app.events_consumer feeds app.events from the app.events_queue (Kafka) table" in found[0]
    assert "refreshable materialized view app.events_refresh writes into app.events" in found[1]
    assert "app.events_previous already exists in the schema" in found[2]
    # The drop mode does not keep the old table under that name.
    assert len(messages(definitions=[NEW, queue, consumer, previous], old_table="drop")) == 1


# ---------- migration file rendering + markers ----------


def test_renders_mode_and_before_retry_lines() -> None:
    sql = _build_migration_content(
        generated_at="2026-10-24T12:00:00Z",
        cli_version="0.0.0",
        definition_count=0,
        plan=MigrationPlan.model_validate(
            {
                "operations": [
                    {
                        "type": "cutover_wait_for_inserts",
                        "key": "table:app.t:cutover:mirror_barrier",
                        "risk": "safe",
                        "mode": "barrier",
                        "sql": "SELECT query_id FROM system.processes;",
                    },
                    {
                        "type": "exchange_tables",
                        "key": "table:app.t",
                        "risk": "caution",
                        "beforeRetry": "SELECT throwIf(1,\n 'swapped')",
                        "warning": "Check first.",
                        "sql": "EXCHANGE TABLES app.t AND app.s;",
                    },
                ],
                "riskSummary": {"safe": 1, "caution": 1, "danger": 0},
                "renameSuggestions": [],
            }
        ),
    )
    assert "\n".join(
        [
            "-- operation: cutover_wait_for_inserts key=table:app.t:cutover:mirror_barrier risk=safe mode=barrier",
            "SELECT query_id FROM system.processes;",
            "",
            "-- operation: exchange_tables key=table:app.t risk=caution",
            "-- before-retry: SELECT throwIf(1, 'swapped')",
            "-- Warning: Check first.",
            "EXCHANGE TABLES app.t AND app.s;",
        ]
    ) in sql
    summaries = extract_migration_operation_summaries(sql)
    assert [(s.type, s.mode, s.before_retry) for s in summaries] == [
        ("cutover_wait_for_inserts", "barrier", None),
        ("exchange_tables", "sync", "SELECT throwIf(1, 'swapped')"),
    ]


# ---------- insert barrier + exchange wait ----------


@dataclass
class _Rows:
    rows: list[dict[str, Any]]


@dataclass
class _ProcessesClient:
    """``polls`` lists the query ids system.processes returns on each read."""

    polls: list[list[str]]
    replicas: int = 1
    queries: list[str] = field(default_factory=list[str])

    def query(self, sql: str) -> _Rows:
        self.queries.append(sql)
        if "system.one" in sql:
            return _Rows([{"replicas": self.replicas}])
        reads = sum(1 for q in self.queries if "system.processes" in q)
        ids = self.polls[min(reads - 1, len(self.polls) - 1)]
        return _Rows([{"query_id": query_id} for query_id in ids])


_BARRIER = "SELECT query_id FROM system.processes WHERE query_kind IN ('Insert', 'AsyncInsertFlush');"


def test_barrier_returns_at_once_without_running_inserts() -> None:
    client = _ProcessesClient([[]])
    assert wait_for_insert_barrier(client, _BARRIER, sleep=lambda _s: None) == 0
    assert len([q for q in client.queries if "system.processes" in q]) == 1


def test_barrier_waits_only_for_inserts_of_the_first_read() -> None:
    client = _ProcessesClient([["a", "b"], ["b", "c"], ["c", "d"]])
    assert wait_for_insert_barrier(client, _BARRIER, sleep=lambda _s: None) == 2
    reads = [q for q in client.queries if "system.processes" in q]
    assert len(reads) == 3
    assert not reads[-1].endswith(";")


def test_barrier_reads_every_replica() -> None:
    client = _ProcessesClient([["a"], []], replicas=2)
    wait_for_insert_barrier(client, _BARRIER, sleep=lambda _s: None)
    assert "FROM clusterAllReplicas('default', system.processes) WHERE" in client.queries[-1]


def test_barrier_times_out_with_the_running_query_ids() -> None:
    clock = [0.0]

    def sleep(seconds: float) -> None:
        clock[0] += seconds

    client = _ProcessesClient([["a", "b"], ["a"]])
    with pytest.raises(
        RuntimeError,
        match=r"1 INSERT query that started before this step is still running after 3s \(query_id a\)",
    ):
        wait_for_insert_barrier(
            client,
            _BARRIER,
            sleep=sleep,
            now=lambda: clock[0],
            poll_interval_seconds=1.0,
            timeout_seconds=3.0,
        )


def test_parse_exchange_tables() -> None:
    assert parse_exchange_tables(
        "EXCHANGE TABLES app.events AND app.`events shadow` ON CLUSTER 'c';"
    ) == (("app", "events"), ("app", "events shadow"))
    assert parse_exchange_tables("DROP TABLE app.events") is None
    # migrate_apply runs a statement together with its marker comment lines.
    assert parse_exchange_tables(
        "-- operation: exchange_tables key=table:app.events risk=caution\n"
        "-- before-retry: SELECT 1\n"
        "EXCHANGE TABLES app.events AND app.events__cutover_1"
    ) == (("app", "events"), ("app", "events__cutover_1"))
    assert parse_exchange_tables("-- EXCHANGE TABLES app.a AND app.b") is None


def test_wait_for_exchange_waits_for_uuid_agreement(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ddl_propagation.time, "sleep", lambda _: None)
    answers = [
        [
            {"database": "app", "name": "a", "replicas": 2, "uuids": 2, "sample_uuid": "u1"},
            {"database": "app", "name": "b", "replicas": 2, "uuids": 2, "sample_uuid": "u2"},
        ],
        [
            {"database": "app", "name": "a", "replicas": 2, "uuids": 1, "sample_uuid": "u2"},
            {"database": "app", "name": "b", "replicas": 2, "uuids": 1, "sample_uuid": "u1"},
        ],
    ]
    polls: list[str] = []

    class _Client:
        def query(self, sql: str) -> _Rows:
            if "system.one" in sql:
                return _Rows([{"replicas": 2}])
            polls.append(sql)
            return _Rows(answers[min(len(polls) - 1, len(answers) - 1)])

    wait_for_exchange(_Client(), "EXCHANGE TABLES app.a AND app.b;")
    assert len(polls) == 2
    # The same SQL as TS waitForExchange: the names are string literals.
    assert polls[0] == (
        "SELECT database, name, count(DISTINCT hostName()) AS replicas, "
        "uniqExact(uuid) AS uuids, any(toString(uuid)) AS sample_uuid "
        "FROM clusterAllReplicas('default', system.tables) "
        "WHERE (database = 'app' AND name = 'a') OR (database = 'app' AND name = 'b') "
        "GROUP BY database, name"
    )


def test_wait_for_exchange_skips_on_cluster() -> None:
    class _Client:
        def query(self, _sql: str) -> _Rows:
            msg = "no query expected"
            raise AssertionError(msg)

    wait_for_exchange(_Client(), "EXCHANGE TABLES app.a AND app.b ON CLUSTER 'c';", cluster="c")


# ---------- apply: sync before-retry + barrier ----------

_SQL = (
    "-- operation: cutover_validate key=table:default.t:cutover:start risk=caution\n"
    "SELECT 1;\n"
    "-- operation: exchange_tables key=table:default.t risk=caution\n"
    "-- before-retry: SELECT throwIf(swapped, 'already swapped')\n"
    "EXCHANGE TABLES default.t AND default.s;\n"
)


@dataclass
class _FakeStore:
    state: MigrationRowState | None = None
    appended: list[MigrationJournalEntry] = field(default_factory=list)

    def read_migration_state(self, _name: str) -> MigrationRowState | None:
        return self.state

    def write_migration_state(self, state: MigrationRowState) -> None:
        self.state = state

    def append_entry(self, entry: MigrationJournalEntry, *, chkit_version: str) -> None:
        _ = chkit_version
        self.appended.append(entry)


class _Runtime:
    def run_on_before_apply(self, context: Any) -> list[str]:
        return list(context.statements)

    def run_on_after_apply(self, _context: Any) -> None:
        return None


class _RecordingClient:
    def __init__(self, fail: str | None = None, polls: list[list[str]] | None = None) -> None:
        self.calls: list[str] = []
        self.reads: list[str] = []
        self._fail = fail
        self._polls = polls or [[]]

    def execute(self, statement: str) -> None:
        self.calls.append(statement)
        if self._fail is not None and statement.startswith(self._fail):
            msg = f"boom: {statement}"
            raise RuntimeError(msg)

    def query(self, sql: str) -> _Rows:
        if "system.one" in sql:
            msg = "no cluster"
            raise RuntimeError(msg)
        self.reads.append(sql)
        if "system.processes" in sql:
            index = sum(1 for read in self.reads if "system.processes" in read) - 1
            ids = self._polls[min(index, len(self._polls) - 1)]
            return _Rows([{"query_id": query_id} for query_id in ids])
        return _Rows([{"x": 1}])


def _sql_lines(calls: list[str]) -> list[str]:
    """The executed SQL without the marker comments a statement carries."""
    return [call.split("\n")[-1] for call in calls]


def _op_state(index: int, status: str, type_: str, key: str) -> OperationState:
    return OperationState(
        operation_index=index,
        operation_key=key,
        operation_type=type_,
        query_id="",
        status=status,  # type: ignore[arg-type]
        started_at="2026-10-24 00:00:00.000",
        finished_at=None if status == "started" else "2026-10-24 00:00:01.000",
        last_error="",
    )


def _state(operations: list[OperationState]) -> MigrationRowState:
    return MigrationRowState(
        name="m.sql",
        applied_at="2026-10-24 00:00:01.000",
        checksum=checksum_sql(_SQL),
        chkit_version="0.0.0-test",
        migration_completed=False,
        operations=operations,
    )


def _run(tmp_path: Path, sql: str, client: _RecordingClient, store: _FakeStore) -> None:
    (tmp_path / "m.sql").write_text(sql, encoding="utf-8")
    apply_migration(
        ApplyMigrationInput(
            client=cast(Any, client),
            journal_store=cast(Any, store),
            plugin_runtime=cast(Any, _Runtime()),
            config=cast(Any, SimpleNamespace(clickhouse=None)),
            table_scope=cast(Any, None),
            migrations_dir=tmp_path,
            file="m.sql",
            retry=None,
            log=lambda _line: None,
            warn=lambda _line: None,
        )
    )


@pytest.fixture
def _apply_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(migrate_apply, "__version__", "0.0.0-test")
    monkeypatch.setattr("chkit.clickhouse.ddl_propagation.resolve_replica_fanout", lambda *_: None)
    monkeypatch.setattr("chkit.clickhouse.insert_barrier.resolve_replica_fanout", lambda *_: None)
    monkeypatch.setattr(
        "chkit.clickhouse.async_insert_guard.resolve_replica_fanout", lambda *_: None
    )


START = ("cutover_validate", "table:default.t:cutover:start")
EXCHANGE = ("exchange_tables", "table:default.t")


@pytest.mark.usefixtures("_apply_env")
def test_apply_does_not_run_before_retry_on_the_first_attempt(tmp_path: Path) -> None:
    client = _RecordingClient()
    _run(tmp_path, _SQL, client, _FakeStore())
    assert _sql_lines(client.calls) == ["SELECT 1", "EXCHANGE TABLES default.t AND default.s"]


@pytest.mark.usefixtures("_apply_env")
def test_apply_guard_stops_the_retry_of_an_interrupted_exchange(tmp_path: Path) -> None:
    client = _RecordingClient(fail="SELECT throwIf(swapped")
    store = _FakeStore(_state([_op_state(0, "completed", *START), _op_state(1, "started", *EXCHANGE)]))
    with pytest.raises(RuntimeError, match=r"boom: SELECT throwIf\(swapped"):
        _run(tmp_path, _SQL, client, store)
    assert client.calls == ["SELECT throwIf(swapped, 'already swapped')"]


@pytest.mark.usefixtures("_apply_env")
def test_apply_retries_a_failed_statement_once_its_guard_passes(tmp_path: Path) -> None:
    client = _RecordingClient()
    store = _FakeStore(_state([_op_state(0, "completed", *START), _op_state(1, "failed", *EXCHANGE)]))
    _run(tmp_path, _SQL, client, store)
    assert _sql_lines(client.calls) == [
        "SELECT throwIf(swapped, 'already swapped')",
        "EXCHANGE TABLES default.t AND default.s",
    ]
    assert len(store.appended) == 1


@pytest.mark.usefixtures("_apply_env")
def test_apply_barrier_waits_instead_of_executing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sql = (
        "-- operation: cutover_wait_for_inserts key=table:default.t:cutover:mirror_barrier "
        "risk=safe mode=barrier\n" + _BARRIER + "\n"
    )
    client = _RecordingClient(polls=[["q1"], ["q1"], []])
    store = _FakeStore()
    barrier = migrate_apply.wait_for_insert_barrier

    def fast_barrier(*args: Any, **kwargs: Any) -> int:
        return barrier(*args, **kwargs, sleep=lambda _s: None)

    monkeypatch.setattr(migrate_apply, "wait_for_insert_barrier", fast_barrier)
    _run(tmp_path, sql, client, store)
    assert client.calls == []
    assert len([read for read in client.reads if "system.processes" in read]) == 3
    assert len(store.appended) == 1


# ---------- apply: fire-and-forget async insert guard ----------

_GUARD_SQL = (
    "-- operation: cutover_validate key=table:app.events:cutover:start risk=caution\n"
    "SELECT 1;\n"
    "-- operation: cutover_snapshot key=table:app.events:cutover:snapshot risk=caution\n"
    "ALTER TABLE app.events__cutover_1_snapshot ATTACH PARTITION ALL FROM app.events;\n"
    "-- operation: exchange_tables key=table:app.events risk=caution\n"
    "EXCHANGE TABLES app.events AND app.events__cutover_1;\n"
)


class _QueryLogClient(_RecordingClient):
    """query_log reports fire-and-forget async inserts into the tables ``busy`` returns."""

    def __init__(self, busy: Any) -> None:
        super().__init__()
        self.guard_reads: list[str] = []
        self._busy = busy

    def query(self, sql: str) -> _Rows:
        if "system.query_log" not in sql:
            return super().query(sql)
        self.guard_reads.append(sql)
        return _Rows([{"table": name, "inserts": 3} for name in self._busy(sql)])


@pytest.mark.usefixtures("_apply_env")
def test_apply_checks_the_cutover_table_at_the_start_and_both_tables_before_the_exchange(
    tmp_path: Path,
) -> None:
    client = _QueryLogClient(lambda _sql: [])
    _run(tmp_path, _GUARD_SQL, client, _FakeStore())
    assert len(client.guard_reads) == 2
    assert "hasAny(tables, ['app.events'])" in client.guard_reads[0]
    assert "hasAny(tables, ['app.events', 'app.events__cutover_1'])" in client.guard_reads[1]
    assert len(client.calls) == 3


@pytest.mark.usefixtures("_apply_env")
def test_apply_stops_a_cutover_before_its_copy_while_fire_and_forget_inserts_run(
    tmp_path: Path,
) -> None:
    client = _QueryLogClient(lambda _sql: ["app.events"])
    with pytest.raises(
        migrate_apply.StatementError,
        match=r"(?s)Migration m.sql failed at statement 1 of 3:.*3 into app.events",
    ):
        _run(tmp_path, _GUARD_SQL, client, _FakeStore())
    assert client.calls == []


@pytest.mark.usefixtures("_apply_env")
def test_apply_refuses_the_exchange_when_such_inserts_started_during_the_cutover(
    tmp_path: Path,
) -> None:
    client = _QueryLogClient(
        lambda sql: ["app.events"] if "app.events__cutover_1" in sql else []
    )
    store = _FakeStore()
    with pytest.raises(migrate_apply.StatementError, match="wait_for_async_insert = 0"):
        _run(tmp_path, _GUARD_SQL, client, store)
    assert _sql_lines(client.calls) == [
        "SELECT 1",
        "ALTER TABLE app.events__cutover_1_snapshot ATTACH PARTITION ALL FROM app.events",
    ]
    # The refused EXCHANGE is not journaled as started.
    assert store.state is not None
    assert [op.operation_index for op in store.state.operations] == [0, 1]


@pytest.mark.usefixtures("_apply_env")
def test_apply_does_not_guard_other_statements(tmp_path: Path) -> None:
    sql = (
        "-- operation: cutover_validate key=table:app.events:cutover:before_exchange risk=caution\n"
        "SELECT 1;\n"
        "-- operation: drop_table key=table:app.events__cutover_1 risk=danger\n"
        "DROP TABLE app.events__cutover_1;\n"
    )
    client = _QueryLogClient(lambda _sql: ["app.events"])
    _run(tmp_path, sql, client, _FakeStore())
    assert client.guard_reads == []


@pytest.mark.usefixtures("_apply_env")
def test_apply_stops_when_the_exchange_does_not_reach_every_replica(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Two replicas behind a load balancer, and system.tables never agrees on the swap.
    monkeypatch.setattr(
        "chkit.clickhouse.ddl_propagation.resolve_replica_fanout",
        lambda *_: ReplicaFanout(cluster="default", replicas=2),
    )
    monkeypatch.setattr(ddl_propagation.time, "sleep", lambda _: None)
    client = _QueryLogClient(lambda _sql: [])
    store = _FakeStore()
    with pytest.raises(
        RuntimeError,
        match=r"EXCHANGE TABLES app.events AND app.events__cutover_1 not applied on every "
        r"replica after \d+ checks: only 1 of the 2 tables are listed",
    ):
        _run(tmp_path, _GUARD_SQL, client, store)
    assert any("system.tables" in read for read in client.reads)
    assert store.appended == []
    # The EXCHANGE ran and is journaled as completed, so a re-run does not swap back.
    assert store.state is not None
    assert [op.status for op in store.state.operations] == ["completed"] * 3


@pytest.mark.usefixtures("_apply_env")
def test_apply_still_only_warns_when_another_propagation_wait_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def slow(*_args: Any, **_kwargs: Any) -> None:
        msg = "not visible yet"
        raise RuntimeError(msg)

    monkeypatch.setattr(migrate_apply, "wait_for_ddl_propagation", slow)
    sql = "-- operation: drop_table key=table:app.t risk=danger\nDROP TABLE app.t;\n"
    warnings: list[str] = []
    (tmp_path / "m.sql").write_text(sql, encoding="utf-8")
    store = _FakeStore()
    apply_migration(
        ApplyMigrationInput(
            client=cast(Any, _RecordingClient()),
            journal_store=cast(Any, store),
            plugin_runtime=cast(Any, _Runtime()),
            config=cast(Any, SimpleNamespace(clickhouse=None)),
            table_scope=cast(Any, None),
            migrations_dir=tmp_path,
            file="m.sql",
            retry=None,
            log=lambda _line: None,
            warn=warnings.append,
        )
    )
    assert warnings == ["  ⚠ DDL propagation wait failed for table:app.t: not visible yet"]
    assert len(store.appended) == 1


# ---------- generate helpers ----------


def test_resolve_cutover_flags_defaults() -> None:
    resolved = resolve_cutover_flags(cutover=["app.events=id"], copy=None, old_table=None)
    assert resolved.requests == [CutoverRequest("app", "events", ["id"])]
    assert (resolved.copy, resolved.old_table) == ("migration", "keep")


def test_resolve_cutover_flags_rejects_invalid_usage() -> None:
    with pytest.raises(ValueError, match=re.escape('Invalid --cutover-copy "inline". Expected migration or backfill.')):
        resolve_cutover_flags(cutover=["app.events=id"], copy="inline", old_table=None)
    with pytest.raises(ValueError, match=re.escape('Invalid --cutover-old "archive". Expected keep or drop.')):
        resolve_cutover_flags(cutover=["app.events=id"], copy=None, old_table="archive")
    with pytest.raises(ValueError, match=re.escape("--cutover app.events is given more than once.")):
        resolve_cutover_flags(cutover=["app.events=id", "app.events=user_id"], copy=None, old_table=None)
    with pytest.raises(ValueError, match="add --cutover"):
        resolve_cutover_flags(cutover=[], copy=None, old_table="drop")


def _retained() -> TableDefinition:
    return events(["id"], name="events_previous").model_copy(
        update={"retained_by": TableRetainedBy(cutover="app.events")}
    )


def test_carry_retained_keeps_retained_tables_planned() -> None:
    retained, current = _retained(), NEW
    definitions = carry_retained_definitions(
        previous_definitions=[current, retained], definitions=[current], drop_retained=[]
    )
    assert definitions == [current, retained]
    assert plan_diff([current, retained], definitions).operations == []


def test_drop_retained_plans_the_drop() -> None:
    retained, current = _retained(), NEW
    definitions = carry_retained_definitions(
        previous_definitions=[current, retained],
        definitions=[current],
        drop_retained=["app.events_previous"],
    )
    assert definitions == [current]
    ops = plan_diff([current, retained], definitions).operations
    assert [(op.type, op.risk) for op in ops] == [("drop_table", "danger")]
    with pytest.raises(
        ValueError,
        match=r"--drop-retained app.events: no table retained by a cutover has that name "
        r"\(retained: app.events_previous\).",
    ):
        carry_retained_definitions(
            previous_definitions=[current, retained], definitions=[current], drop_retained=["app.events"]
        )


def test_apply_cutovers_replaces_the_recreate() -> None:
    plan_ = plan_diff([OLD], [NEW])
    assert [op.type for op in plan_.operations] == ["drop_table", "create_table"]
    result, cutovers = apply_cutovers(
        plan=plan_,
        previous_definitions=[OLD],
        definitions=[NEW],
        cutovers=resolve_cutover_flags(cutover=["app.events=id"], copy=None, old_table=None),
        cluster=None,
        stamp=STAMP,
    )
    assert not any(op.type == "drop_table" and op.key == "table:app.events" for op in result.operations)
    assert len([op for op in result.operations if op.type == "exchange_tables"]) == 1
    assert result.risk_summary.model_dump() == {"safe": 6, "caution": 15, "danger": 0}
    summary = summarize_cutover(cutovers[0])
    assert summary["table"] == "app.events"
    assert summary["retainedAs"] == "app.events_previous"
    assert summary["nextSteps"] == ["chkit migrate --apply"]


def test_apply_cutovers_refuses_a_table_that_is_not_recreated() -> None:
    with pytest.raises(ValueError, match=re.escape("--cutover app.events: the plan does not recreate app.events")):
        apply_cutovers(
            plan=plan_diff([OLD], [OLD]),
            previous_definitions=[OLD],
            definitions=[OLD],
            cutovers=resolve_cutover_flags(cutover=["app.events=id"], copy=None, old_table=None),
            cluster=None,
            stamp=STAMP,
        )


def test_apply_cutovers_refuses_a_dependent_view_recreated_in_the_same_migration() -> None:
    def counts(as_: str) -> SchemaDefinition:
        return materialized_view(
            database="app",
            name="events_counts_mv",
            to={"database": "app", "name": "events_counts"},
            as_=as_,
        )

    before = counts("SELECT user_id, count() AS n FROM app.events GROUP BY user_id")
    after = counts("SELECT user_id, count() AS n, max(id) AS last FROM app.events GROUP BY user_id")
    plan_ = plan_diff([OLD, before], [NEW, after])
    assert "drop_materialized_view" in [op.type for op in plan_.operations]
    with pytest.raises(
        ValueError,
        match=re.escape(
            "--cutover app.events: app.events_counts_mv reads from or writes into app.events and "
            "is recreated in the same migration, so it would miss every INSERT during the "
            "cutover. Change it in a separate migration, before or after the cutover."
        ),
    ):
        apply_cutovers(
            plan=plan_,
            previous_definitions=[OLD, before],
            definitions=[NEW, after],
            cutovers=resolve_cutover_flags(cutover=["app.events=id"], copy=None, old_table=None),
            cluster=None,
            stamp=STAMP,
        )


def test_apply_cutovers_refuses_a_recreated_view_that_reads_the_table() -> None:
    before = view(database="app", name="events_v", as_="SELECT id FROM events")
    after = view(database="app", name="events_v", as_="SELECT id, user_id FROM events")
    plan_ = plan_diff([OLD, before], [NEW, after])
    with pytest.raises(ValueError, match=re.escape("--cutover app.events: app.events_v reads from")):
        apply_cutovers(
            plan=plan_,
            previous_definitions=[OLD, before],
            definitions=[NEW, after],
            cutovers=resolve_cutover_flags(cutover=["app.events=id"], copy=None, old_table=None),
            cluster=None,
            stamp=STAMP,
        )


# ---------- backfill cutover chunk SQL ----------


def test_cutover_chunk_skips_keys_the_shadow_holds() -> None:
    chunk = Chunk.model_validate(
        {
            "id": "c1",
            "partitionId": "all",
            "ranges": [
                {"dimensionIndex": 0, "from": "100", "to": "200"},
                {"dimensionIndex": 1, "from": "5"},
            ],
            "estimate": {
                "rows": 1,
                "bytesCompressed": 1,
                "bytesUncompressed": 1,
                "confidence": "exact",
                "reason": "exact-count",
            },
            "analysis": {"lineage": []},
        }
    )
    profile = TableProfile.model_validate(
        {
            "database": "db",
            "table": "events__cutover_1_snapshot",
            "sortKeys": [
                {"name": "id", "type": "UInt64", "category": "numeric", "boundaryEncoding": "literal"},
                {"name": "toDate(ts)", "type": "Date", "category": "numeric", "boundaryEncoding": "literal"},
            ],
        }
    )
    sql = build_chunk_execution_sql(
        plan_id="p",
        chunk=chunk,
        target="db.events__cutover_1",
        source_target="db.events__cutover_1_snapshot",
        table=profile,
        target_columns=["id", "ts"],
        cutover_key=["id"],
    )
    assert sql.split("\n")[1:] == [
        "INSERT INTO db.events__cutover_1 (`id`, `ts`)",
        "SELECT `id`, `ts`",
        "FROM db.events__cutover_1_snapshot",
        "WHERE _partition_id = 'all'",
        "  AND id >= '100'",
        "  AND id < '200'",
        "  AND toDate(ts) >= '5'",
        "  AND (`id`) NOT IN (SELECT `id` FROM db.events__cutover_1 WHERE id >= '100' AND id < '200')",
        "SETTINGS async_insert=0, asterisk_include_materialized_columns=0, "
        "asterisk_include_alias_columns=0, insert_deduplicate=0, select_sequential_consistency=1",
    ]
