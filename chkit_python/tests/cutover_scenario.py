"""Zero-downtime cutover scenario (#202), shared by ``tests/test_cutover_e2e.py``
(local ClickHouse, ObsessionDB) and ``tests_cluster/test_cutover_cluster_e2e.py``.

Port of ``packages/cli/src/test/cutover-scenario.ts``. The table changes its
ORDER BY while writers keep inserting, directly and through a materialized view
chained in front of it. A second materialized view reads from the table. After
the cutover the table must hold every row exactly once, the reading view must
have seen every row exactly once, and chkit must report nothing pending,
drifted or left to generate.

The CLI runs in-process (``typer.testing.CliRunner``) while writer threads,
each with its own connection, keep inserting.
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from typer.testing import CliRunner

from chkit.cli.commands.migrate_async_apply import iso_without_zone
from chkit.cli.journal_store import JournalStore, MigrationRowState
from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient, clickhouse_error_code
from chkit.clickhouse.ddl_propagation import wait_for_table, wait_for_table_absent
from chkit.clickhouse.replicas import resolve_replica_fanout_or_raise
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    wait_for_table_on_every_replica,
)

HISTORIC_ROWS = 20_000
BATCH_ROWS = 200
NESTED_HISTORIC_ROWS = 2_000
NESTED_COLUMNS: list[dict[str, Any]] = [
    {"name": "id", "type": "UInt64"},
    {"name": "user_id", "type": "UInt64"},
    {"name": "payload", "type": "String"},
    {"name": "n", "type": "Nested(x UInt64, `y z` Decimal64(2))"},
]
NESTED_X = "arrayMap(i -> id * 10 + i, range(id % 5 + 1))"
NESTED_Y = "arrayMap(i -> toDecimal64(id, 2) + toDecimal64(i * 10 + 5, 2) / 100, range(id % 5 + 1))"


@dataclass
class CutoverTarget:
    database: str
    # url, username, password, database[, cluster] of the chkit config.
    connection: dict[str, str]
    # Runs DDL and verification reads.
    admin: ClickHouseClient
    # Connection settings the writer threads open their own clients with.
    writer_configs: list[ChxResolvedClickHouseConfig]
    engine: str
    # Every row of a table across shards: a qualified name, or cluster(...).
    rows_of: Callable[[str], str]
    # Appended to verification reads, e.g. select_sequential_consistency on ObsessionDB.
    read_settings: str
    # Makes every replica hold the rows of the tables before they are counted
    # (Replicated tables fetch parts asynchronously). TS ``settle``.
    settle: Callable[[list[str]], None] | None = None

    @property
    def cluster(self) -> str | None:
        return self.connection.get("cluster")


@dataclass
class CutoverProject:
    dir: Path
    journal_table: str
    table: str
    by_user: str
    ingest: str
    previous: str
    historic: int = HISTORIC_ROWS
    # The table's columns in the schema, when they are not id, user_id and payload.
    columns: list[dict[str, Any]] | None = None


@dataclass
class WriterReport:
    batches: int = 0
    rows: int = 0
    nested_rows: int = 0
    errors: list[str] = field(default_factory=list)


@dataclass
class CliOutcome:
    exit_code: int
    stdout: str
    output: str


def create_cutover_project(
    target: CutoverTarget,
    label: str,
    directory: Path,
    columns: list[dict[str, Any]] | None = None,
) -> CutoverProject:
    """Write config + schema, migrate the initial table and insert the historic rows.

    The caller chdirs into ``directory`` and sets ``CHKIT_JOURNAL_TABLE``.
    """
    prefix = create_prefix(f"py_{label}")
    project = CutoverProject(
        dir=directory,
        journal_table=create_journal_table_name(f"py_{label}"),
        table=f"{prefix}events",
        by_user=f"{prefix}events_by_user",
        ingest=f"{prefix}ingest",
        previous=f"{prefix}events_previous",
        columns=columns,
    )
    os.environ["CHKIT_JOURNAL_TABLE"] = project.journal_table
    config = {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "clickhouse": target.connection,
    }
    backfill_options = {"stateDir": str(directory / "chkit/backfill"), "maxChunkBytes": 256 * 1024}
    (directory / "clickhouse.config.py").write_text(
        "from chkit import define_config\n"
        "from chkit_plugin_backfill import backfill\n\n"
        f"_config = {json.dumps(config)}\n"
        f"_config['plugins'] = [backfill({json.dumps(backfill_options)})]\n"
        "config = define_config(_config)\n",
        encoding="utf-8",
    )
    # chkit creates the journal and reads it right away; on a multi-replica
    # service the read can land on a replica that has not applied that CREATE.
    JournalStore(target.admin, target.cluster)._ensure_table(create=True)
    if target.cluster is None:
        wait_for_table_on_every_replica(target.admin, target.database, project.journal_table)
    write_schema(target, project, ["id"])
    expect_ok(cli(["generate", "--name", "init", "--json"]), "generate init")
    expect_ok(cli(["migrate", "--apply", "--json"]), "migrate init")
    half = HISTORIC_ROWS // 2
    db = target.database
    first = ClickHouseClient.connect(target.writer_configs[0])
    second = ClickHouseClient.connect(target.writer_configs[-1])
    try:
        first.execute(
            f"INSERT INTO {db}.{project.table} (id, user_id, payload) "
            f"SELECT number, number % 97, 'historic' FROM numbers({half})"
        )
        second.execute(
            f"INSERT INTO {db}.{project.ingest} (id, user_id, payload) "
            f"SELECT {half} + number, number % 97, 'historic' FROM numbers({half})"
        )
    finally:
        first.close()
        second.close()
    return project


def write_schema(
    target: CutoverTarget,
    project: CutoverProject,
    order_by: list[str],
    settings: dict[str, int] | None = None,
) -> None:
    # The chained source is a MergeTree table here, not Null as in the TS
    # scenario: chkit-py's live drift reports a Null table as engine_mismatch
    # (pre-existing, unrelated to the cutover).
    db = target.database
    engine = target.engine
    (project.dir / "schema.py").write_text(
        f"""from chkit import materialized_view, schema, table

columns = [
    {{"name": "id", "type": "UInt64"}},
    {{"name": "user_id", "type": "UInt64"}},
    {{"name": "payload", "type": "String"}},
]
table_columns = {project.columns!r} or columns

events = table(database={db!r}, name={project.table!r}, engine={engine!r}, columns=table_columns,
               primary_key={order_by!r}, order_by={order_by!r}, settings={settings!r})
by_user = table(database={db!r}, name={project.by_user!r}, engine={engine!r},
                columns=[{{"name": "user_id", "type": "UInt64"}}, {{"name": "id", "type": "UInt64"}}],
                primary_key=["user_id"], order_by=["user_id", "id"])
by_user_mv = materialized_view(database={db!r}, name={project.by_user + "_mv"!r},
                               to={{"database": {db!r}, "name": {project.by_user!r}}},
                               as_={f"SELECT user_id, id FROM {db}.{project.table}"!r})
ingest = table(database={db!r}, name={project.ingest!r}, engine={engine!r}, columns=columns,
               primary_key=["id"], order_by=["id"])
ingest_mv = materialized_view(database={db!r}, name={project.ingest + "_mv"!r},
                              to={{"database": {db!r}, "name": {project.table!r}}},
                              as_={f"SELECT id, user_id, payload FROM {db}.{project.ingest}"!r})

definitions = schema(events, by_user, by_user_mv, ingest, ingest_mv)
""",
        encoding="utf-8",
    )


class Writers:
    """Insert batches of fresh ids until stopped, alternating a direct INSERT and
    an INSERT into the chained source, round robin over the writer connections.
    Only batches that succeeded count. A batch rejected with TABLE_UUID_MISMATCH
    (741) overlapped the swap and wrote nothing, so it is retried once, as the
    cutover guide tells writers to; any other error fails the scenario."""

    def __init__(
        self, target: CutoverTarget, project: CutoverProject, parallel: int = 2, *, nested: bool = False
    ) -> None:
        self._target = target
        self._project = project
        self._nested = nested
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._next = 0
        self.report = WriterReport()
        self._threads = [
            threading.Thread(target=self._loop, args=(worker,), daemon=True)
            for worker in range(parallel)
        ]
        for thread in self._threads:
            thread.start()

    def _take(self) -> int:
        with self._lock:
            batch = self._next
            self._next += 1
            return batch

    def _loop(self, worker: int) -> None:
        configs = self._target.writer_configs
        clients = [ClickHouseClient.connect(config) for config in configs]
        db = self._target.database
        try:
            while not self._stop.is_set():
                batch = self._take()
                writer = batch // 2 if self._nested else batch
                client = clients[writer % len(clients)]
                direct = batch % 2 == 0
                into = self._project.table if direct else self._project.ingest
                with_nested = self._nested and direct
                start = 1_000_000_000 + batch * BATCH_ROWS
                insert = (
                    _insert_nested_sql(f"{db}.{into}", start, BATCH_ROWS, f"live-nested-{worker}")
                    if with_nested
                    else f"INSERT INTO {db}.{into} (id, user_id, payload) SELECT {start} + number, "
                    f"number % 97, 'live-{worker}' FROM numbers({BATCH_ROWS})"
                )
                try:
                    try:
                        client.execute(insert)
                    except Exception as error:
                        if clickhouse_error_code(error) != "741":
                            raise
                        client.execute(insert)
                    with self._lock:
                        self.report.batches += 1
                        self.report.rows += BATCH_ROWS
                        if with_nested:
                            self.report.nested_rows += BATCH_ROWS
                except Exception as error:  # reported, the test fails on it
                    with self._lock:
                        self.report.errors.append(str(error))
        finally:
            for client in clients:
                client.close()

    def stop(self) -> WriterReport:
        self._stop.set()
        for thread in self._threads:
            thread.join()
        return self.report


def cli(args: list[str]) -> CliOutcome:
    result = CliRunner().invoke(app, args)
    output = result.output
    if result.exception is not None and not isinstance(result.exception, SystemExit):
        output += f"\n{type(result.exception).__name__}: {result.exception}"
    return CliOutcome(exit_code=result.exit_code, stdout=result.stdout, output=output)


def expect_ok(outcome: CliOutcome, label: str) -> CliOutcome:
    assert outcome.exit_code == 0, format_test_diagnostic(label, outcome)
    return outcome


def json_of(outcome: CliOutcome, label: str) -> dict[str, Any]:
    expect_ok(outcome, label)
    payload: dict[str, Any] = json.loads(outcome.stdout)
    return payload


def cutover_migration(project: CutoverProject) -> str:
    # Generated with --name cutover; the init migration may share its timestamp.
    files = sorted(p.name for p in (project.dir / "chkit/migrations").glob("*_cutover.sql"))
    assert len(files) == 1, f"expected one cutover migration, found {files}"
    return files[0]


def rows(target: CutoverTarget, sql: str) -> list[dict[str, Any]]:
    return target.admin.query(f"{sql}{target.read_settings}").rows


def assert_cutover_rows(target: CutoverTarget, project: CutoverProject, report: WriterReport) -> None:
    """The table holds the historic rows and every row a writer inserted, each
    once; the view reading from it saw each of them once."""
    expected = project.historic + report.rows
    if target.settle is not None:
        target.settle([project.table, project.by_user])
    counts = rows(
        target,
        "SELECT count() AS total, uniqExact(id) AS ids, countIf(payload LIKE 'live%') AS live "
        f"FROM {target.rows_of(project.table)}",
    )[0]
    by_user = rows(
        target,
        f"SELECT count() AS total, uniqExact(id) AS ids FROM {target.rows_of(project.by_user)}",
    )[0]
    actual = {
        "total": int(counts["total"]),
        "ids": int(counts["ids"]),
        "live": int(counts["live"]),
        "by_user_total": int(by_user["total"]),
        "by_user_ids": int(by_user["ids"]),
    }
    want = {
        "total": expected,
        "ids": expected,
        "live": report.rows,
        "by_user_total": expected,
        "by_user_ids": expected,
    }
    assert actual == want, f"cutover rows: got {actual}, want {want} (writer errors: {len(report.errors)})"


def _insert_nested_sql(table: str, start: int, count: int, payload: str) -> str:
    return (
        f"INSERT INTO {table} (id, user_id, payload, `n.x`, `n.y z`) "
        f"SELECT {start} + number AS id, number % 97, '{payload}', {NESTED_X}, {NESTED_Y} "
        f"FROM numbers({count})"
    )


def _stored_columns(target: CutoverTarget, project: CutoverProject) -> list[dict[str, Any]]:
    return target.admin.query(
        "SELECT name, type FROM system.columns "
        f"WHERE database = '{target.database}' AND table = '{project.table}' ORDER BY position"
    ).rows


def _nested_drift(table: str) -> dict[str, Any]:
    payload = json_of(cli(["drift", "--table", table, "--json"]), "drift")
    table_drift: list[dict[str, Any]] = payload["tableDrift"]
    detail = next(item for item in table_drift if item["table"] == table)
    # Drift reports the declared Nested name as missing and its stored leaves as extra.
    assert detail["reasonCodes"] == ["missing_column", "extra_column"], detail
    assert detail["missingColumns"] == ["n"], detail
    assert detail["extraColumns"] == ["n.x", "n.y z"], detail
    return detail


def _seed_nested(
    target: CutoverTarget, project: CutoverProject
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    table = f"{target.database}.{project.table}"
    columns = _stored_columns(target, project)
    drift = _nested_drift(table)
    half = NESTED_HISTORIC_ROWS // 2
    for config, start in (
        (target.writer_configs[0], project.historic),
        (target.writer_configs[-1], project.historic + half),
    ):
        client = ClickHouseClient.connect(config)
        try:
            client.execute(_insert_nested_sql(table, start, half, "nested-historic"))
        finally:
            client.close()
    project.historic += NESTED_HISTORIC_ROWS
    return columns, drift


def _assert_nested_rows(
    target: CutoverTarget,
    project: CutoverProject,
    before: tuple[list[dict[str, Any]], dict[str, Any]],
    expected: int,
) -> None:
    counts = rows(
        target,
        "WITH (payload LIKE 'nested-%' OR payload LIKE 'live-nested-%') AS is_nested "
        "SELECT countIf(is_nested) AS nested, "
        f"countIf(is_nested AND (`n.x` != {NESTED_X} OR `n.y z` != {NESTED_Y})) AS wrong_values, "
        "countIf(NOT is_nested AND (notEmpty(`n.x`) OR notEmpty(`n.y z`))) AS nonempty, "
        "countIf(length(`n.x`) != length(`n.y z`)) AS unaligned "
        f"FROM {target.rows_of(project.table)}",
    )[0]
    assert {key: int(value) for key, value in counts.items()} == {
        "nested": expected, "wrong_values": 0, "nonempty": 0, "unaligned": 0,
    }
    columns, drift = before
    assert _stored_columns(target, project) == columns
    assert _nested_drift(f"{target.database}.{project.table}") == drift


@dataclass(frozen=True)
class CutoverChange:
    """A cutover's change: the new sort key and settings, and the layout
    ``layouts`` reports after it."""

    order_by: list[str]
    layout: str
    settings: dict[str, int] | None = None


ORDER_BY_CHANGE = CutoverChange(order_by=["user_id", "id"], layout="user_id, id|8192")
# Only a read-only setting changes (#511): the guards must tell the tables apart by it.
GRANULARITY_CHANGE = CutoverChange(
    order_by=["id"], layout="id|4096", settings={"index_granularity": 4096}
)


def layouts(target: CutoverTarget, project: CutoverProject) -> dict[str, str]:
    """Sorting key and index_granularity of the table and every cutover table next to it."""
    result = target.admin.query(
        "SELECT name, sorting_key, extract(engine_full, 'index_granularity = ([0-9]+)') "
        f"AS granularity FROM system.tables WHERE database = '{target.database}' AND "
        f"(name IN ('{project.table}', '{project.previous}') OR "
        f"startsWith(name, '{project.table}__cutover_')) ORDER BY name"
    ).rows
    return {
        str(row["name"]): f"{str(row['sorting_key']).strip('()')}|{row['granularity'] or '8192'}"
        for row in result
    }


def sorting_keys(target: CutoverTarget, project: CutoverProject) -> dict[str, str]:
    result = target.admin.query(
        "SELECT name, sorting_key FROM system.tables "
        f"WHERE database = '{target.database}' AND (name IN ('{project.table}', "
        f"'{project.previous}') OR startsWith(name, '{project.table}__cutover_')) ORDER BY name"
    ).rows
    return {str(row["name"]): str(row["sorting_key"]).strip("()") for row in result}


def assert_chkit_clean(*, nested: bool = False) -> None:
    """check (no pending migration, no drift) and generate --dryrun report nothing to do."""
    check = cli(["check", "--json"])
    plan = json_of(cli(["generate", "--dryrun", "--json"]), "generate --dryrun")
    payload = json.loads(check.stdout)
    summary = {
        "check": check.exit_code,
        "pending": payload["pendingCount"],
        "drift_evaluated": payload["driftEvaluated"],
        "drifted": payload["drifted"],
        "failed_checks": payload["failedChecks"],
        "operations": plan["operationCount"],
    }
    assert summary == {
        "check": 1 if nested else 0,
        "pending": 0,
        "drift_evaluated": True,
        "drifted": nested,
        "failed_checks": ["schema_drift"] if nested else [],
        "operations": 0,
    }, f"chkit not clean after the cutover: {summary}\n{check.output}"


def edit_journal_state(
    target: CutoverTarget,
    file: str,
    edit: Callable[[MigrationRowState], MigrationRowState],
) -> None:
    """Rewrite the migration's journal state, e.g. to simulate a lost acknowledgement."""
    store = JournalStore(target.admin, target.cluster)
    state = store.read_migration_state(file)
    assert state is not None, f"no journal state for {file}"
    store.write_migration_state(edit(state))


def drop_cutover_project(target: CutoverTarget, project: CutoverProject) -> None:
    on_cluster = f" ON CLUSTER '{target.cluster}'" if target.cluster else ""
    objects = target.admin.query(
        "SELECT name FROM system.tables "
        f"WHERE database = '{target.database}' AND (startsWith(name, '{project.table}') "
        f"OR startsWith(name, '{project.by_user}') OR startsWith(name, '{project.ingest}')) "
        "ORDER BY engine = 'MaterializedView' DESC"
    ).rows
    for row in objects:
        target.admin.execute(
            f"DROP TABLE IF EXISTS {target.database}.`{row['name']}`{on_cluster} SYNC"
        )
    target.admin.execute(
        f"DROP TABLE IF EXISTS {target.database}.`{project.journal_table}`{on_cluster} SYNC"
    )


def _generate_cutover(
    target: CutoverTarget,
    project: CutoverProject,
    *flags: str,
    change: CutoverChange = ORDER_BY_CHANGE,
) -> dict[str, Any]:
    write_schema(target, project, change.order_by, change.settings)
    return json_of(
        cli(
            [
                "generate",
                "--name",
                "cutover",
                "--cutover",
                f"{target.database}.{project.table}=id",
                *flags,
                "--json",
            ]
        ),
        "generate --cutover",
    )


def run_keep_scenario(
    target: CutoverTarget, label: str, directory: Path, *, nested: bool = False
) -> None:
    """The default cutover: copy inside the migration, old table kept as
    ``<table>_previous``, while writers insert the whole time."""
    project = create_cutover_project(target, label, directory, NESTED_COLUMNS if nested else None)
    try:
        before = _seed_nested(target, project) if nested else None
        generated = _generate_cutover(target, project)
        assert generated["riskSummary"]["danger"] == 0
        assert generated["cutovers"][0]["retainedAs"] == f"{target.database}.{project.previous}"

        writers = Writers(target, project, nested=nested)
        migrate = cli(["migrate", "--apply", "--json"])
        report = writers.stop()
        expect_ok(migrate, "migrate --apply (cutover)")
        assert not report.errors, report.errors[0]
        assert report.batches >= 4, f"writers inserted only {report.batches} batches"

        assert_cutover_rows(target, project, report)
        assert sorting_keys(target, project) == {
            project.table: "user_id, id",
            project.previous: "id",
        }
        # The old table kept every row it received until the mirror was dropped.
        # The rows of an INSERT that straddled the swap are in it twice (and were
        # attached to the new table by the reconcile step).
        if target.settle is not None:
            target.settle([project.previous])
        previous = rows(
            target,
            f"SELECT count() AS total, uniqExact(id) AS ids FROM {target.rows_of(project.previous)}",
        )[0]
        assert int(previous["total"]) >= int(previous["ids"]) >= project.historic, previous
        if before is not None:
            _assert_nested_rows(
                target, project, before, NESTED_HISTORIC_ROWS + report.nested_rows
            )
        assert_chkit_clean(nested=nested)
    finally:
        drop_cutover_project(target, project)


def run_backfill_scenario(
    target: CutoverTarget, label: str, directory: Path, *, nested: bool = False
) -> None:
    """The backfill copy: migrate stops at the copy check, the backfill plugin
    copies the snapshot, and the next apply verifies and swaps. The old table
    is dropped."""
    project = create_cutover_project(target, label, directory, NESTED_COLUMNS if nested else None)
    fqn = f"{target.database}.{project.table}"
    try:
        before = _seed_nested(target, project) if nested else None
        _generate_cutover(target, project, "--cutover-copy", "backfill", "--cutover-old", "drop")
        writers = Writers(target, project, nested=nested)
        try:
            stopped = cli(["migrate", "--apply", "--allow-destructive", "--json"])
            assert stopped.exit_code == 1, stopped.output
            assert f"chkit plugin backfill plan --cutover {fqn}" in stopped.output, stopped.output
            if nested:
                target.admin.execute(_insert_nested_sql(fqn, project.historic, BATCH_ROWS, "nested-paused"))
                project.historic += BATCH_ROWS
            plan = json_of(
                cli(["plugin", "backfill", "plan", "--cutover", fqn, "--json"]), "backfill plan"
            )
            assert plan["strategy"] == "cutover_copy", plan
            assert plan["chunkCount"] >= 2, plan
            expect_ok(
                cli(
                    [
                        "plugin", "backfill", "run", "--plan-id", plan["planId"],
                        "--poll-interval", "200", "--json",
                    ]
                ),
                "backfill run",
            )
            expect_ok(
                cli(["migrate", "--apply", "--allow-destructive", "--json"]),
                "migrate --apply after the backfill",
            )
        finally:
            report = writers.stop()
        assert not report.errors, report.errors[0]
        assert_cutover_rows(target, project, report)
        assert sorting_keys(target, project) == {project.table: "user_id, id"}
        if before is not None:
            _assert_nested_rows(
                target, project, before, NESTED_HISTORIC_ROWS + report.nested_rows + BATCH_ROWS
            )
        assert_chkit_clean(nested=nested)
    finally:
        drop_cutover_project(target, project)


RetryFailures = Literal["retries", "layout guards"]
"""Which statements of the cutover fail once. ``retries``: every statement whose
retry runs other SQL than its first run (before-retry SQL, or the lookup of an
async attempt), and the statement after each one whose acknowledgement is
lost. A retry of any other statement only runs it again, which the migrate
resume unit tests cover. ``layout guards``: the EXCHANGE and the
drop of the old table, whose guards compare the tables' layouts."""


def run_retry_scenario(
    target: CutoverTarget,
    label: str,
    directory: Path,
    change: CutoverChange = ORDER_BY_CHANGE,
    failures: RetryFailures = "retries",
) -> None:
    """Fail statements of the cutover once (see RetryFailures) and resume them
    with --retry, and replay the statements whose acknowledgement can be lost:
    the snapshot (re-taken after a TRUNCATE), the copy (skips what it wrote),
    the EXCHANGE (refuses: it must never swap back) and the drop of the old
    table. Writers insert the whole time; no row may be lost or duplicated."""
    project = create_cutover_project(target, label, directory)
    writers: Writers | None = None
    try:
        _generate_cutover(target, project, "--cutover-old", "drop", change=change)
        writers = Writers(target, project, parallel=1)
        file = cutover_migration(project)
        path = project.dir / "chkit/migrations" / file
        blocks = path.read_text(encoding="utf-8").split("\n\n")
        types = [block.split(" ", 3)[2] for block in blocks[1:]]
        drop_old = next(i for i, block in enumerate(blocks[1:]) if " risk=danger" in block)
        replayed = {
            types.index("cutover_snapshot"): "replays",
            types.index("cutover_copy"): "replays",
            types.index("exchange_tables"): "refuses",
            types.index("cutover_reconcile"): "replays",
            len(types) - 1 - types[::-1].index("cutover_reconcile"): "replays",
            # Refused when the staging table holds rows (an INSERT straddled the swap).
            types.index("cutover_attach"): "refuses if staged",
            drop_old: "replays",
        }

        def migrate(*, retry: bool) -> CliOutcome:
            return cli(
                ["migrate", "--apply", "--allow-destructive", "--json", *(["--retry", file] if retry else [])]
            )

        steps = _retry_steps(blocks, types, drop_old, replayed, failures)
        for attempt, step in enumerate(steps):
            path.write_text(_inject_failure(blocks, step), encoding="utf-8")
            failed = migrate(retry=attempt > 0)
            assert failed.exit_code != 0, f"statement {step + 1} ({types[step]}) must fail"
            assert f"injected failure at statement {step + 1}" in failed.output, failed.output
            lost = replayed.get(step - 1)
            if lost is None:
                continue

            # The previous statement ran, but its acknowledgement was lost: it is
            # recorded as started, and this statement never ran.
            def lose_ack(state: MigrationRowState, step: int = step) -> MigrationRowState:
                operations = [
                    op.model_copy(update={"status": "started", "finished_at": None, "query_id": ""})
                    if op.operation_index == step - 1
                    else op
                    for op in state.operations
                    if op.operation_index != step
                ]
                # A newer version, so FINAL reads it instead of the recorded one.
                return state.model_copy(
                    update={
                        "operations": operations,
                        "applied_at": iso_without_zone(datetime.now(tz=UTC)),
                    }
                )

            edit_journal_state(target, file, lose_ack)
            if lost == "replays":
                continue
            path.write_text(_inject_failure(blocks, step + 1), encoding="utf-8")
            replay = migrate(retry=True)
            if lost == "refuses":
                assert replay.exit_code != 0, replay.output
                assert "the EXCHANGE may already have run" in replay.output, replay.output
                keys = layouts(target, project)
                assert keys[project.table] == change.layout, f"swapped back: {keys}"
            elif "the ATTACH may already have run" not in replay.output:
                # Nothing was staged, so the replayed ATTACH ran and the next statement failed.
                assert f"injected failure at statement {step + 2}" in replay.output, replay.output
                continue
            # Documented recovery: the statement ran, so it becomes a no-op.
            blocks[step] = "\n".join(
                "SELECT 1;" if line.startswith(("EXCHANGE TABLES", "ALTER TABLE")) else line
                for line in blocks[step].split("\n")
                if not line.startswith("-- before-retry:")
            )
        path.write_text("\n\n".join(blocks), encoding="utf-8")
        expect_ok(migrate(retry=True), "migrate --apply --retry (complete)")
        report = writers.stop()
        writers = None
        assert not report.errors, report.errors[0]
        assert_cutover_rows(target, project, report)
        assert layouts(target, project) == {project.table: change.layout}
        assert_chkit_clean()
    finally:
        if writers is not None:
            writers.stop()
        drop_cutover_project(target, project)


def _recreate_table(
    target: CutoverTarget,
    project: CutoverProject,
    create_sql: str,
    settings: dict[str, Any] | None = None,
    *,
    on_cluster: str = "",
) -> None:
    # Probed once and cached, so a failed probe fails here instead of letting the waits read one replica.
    resolve_replica_fanout_or_raise(target.admin, target.cluster)
    target.admin.execute(f"DROP TABLE {target.database}.{project.table}{on_cluster} SYNC")
    # The CREATE may land on a replica that has not applied the DROP.
    wait_for_table_absent(target.admin, target.database, project.table, cluster=target.cluster)
    target.admin.execute(create_sql, settings)
    wait_for_table(target.admin, target.database, project.table, cluster=target.cluster)


def run_undeclared_primary_key_scenario(
    target: CutoverTarget, label: str, directory: Path
) -> None:
    """A table created with only ORDER BY, as outside chkit (#524). Before
    ClickHouse 26.7 its parts attach only to a table that leaves PRIMARY KEY
    out too, so the snapshot must copy the table's stored definition."""
    project = create_cutover_project(target, label, directory)
    try:
        fqn = f"{target.database}.{project.table}"
        _recreate_table(
            target,
            project,
            f"CREATE TABLE {fqn} (id UInt64, user_id UInt64, payload String) "
            f"ENGINE = {target.engine} ORDER BY id",
        )
        created = target.admin.query(
            "SELECT engine_full FROM system.tables "
            f"WHERE database = '{target.database}' AND name = '{project.table}'"
        ).rows
        assert created, "the table is not listed"
        assert " PRIMARY KEY " not in str(created[0]["engine_full"]), created
        target.admin.execute(
            f"INSERT INTO {fqn} (id, user_id, payload) "
            "SELECT number, number % 97, 'historic' FROM numbers(1000)"
        )

        _generate_cutover(target, project)
        expect_ok(cli(["migrate", "--apply", "--json"]), "migrate --apply (cutover)")
        assert sorting_keys(target, project) == {
            project.table: "user_id, id",
            project.previous: "id",
        }
        total = rows(target, f"SELECT count() AS total FROM {target.rows_of(project.table)}")
        assert int(total[0]["total"]) == 1000
        assert_chkit_clean()
    finally:
        drop_cutover_project(target, project)


def run_refused_at_start_scenario(
    target: CutoverTarget,
    label: str,
    directory: Path,
    *,
    columns: str,
    engine: Callable[[str], str],
    message: str,
    order_by: str = "id",
    clauses: str = "",
    settings: dict[str, Any] | None = None,
    schema_columns: list[dict[str, Any]] | None = None,
) -> None:
    """The table is created outside chkit with ``columns`` and the engine that
    ``engine`` returns for its name, which differ from the schema
    (``schema_columns``, or id, user_id and payload). The snapshot is created AS
    the table, so it would take the server's state: the cutover must stop at its
    first statement, before it creates anything. TS
    ``runRefusedAtStartScenario``."""
    project = create_cutover_project(target, label, directory, schema_columns)
    try:
        fqn = f"{target.database}.{project.table}"
        on_cluster = f" ON CLUSTER '{target.cluster}'" if target.cluster else ""
        _recreate_table(
            target,
            project,
            f"CREATE TABLE {fqn}{on_cluster} ({columns}) "
            f"ENGINE = {engine(project.table)} ORDER BY {order_by}"
            + (f" {clauses}" if clauses else ""),
            settings,
            on_cluster=on_cluster,
        )

        _generate_cutover(target, project)
        refused = cli(["migrate", "--apply", "--json"])
        diagnostic = format_test_diagnostic(f'migrate --apply must stop with "{message}"', refused)
        assert refused.exit_code != 0, diagnostic
        assert message in refused.output, diagnostic
        assert "failed at statement 1 of" in refused.output, diagnostic
        tables = (
            f"clusterAllReplicas('{target.cluster}', system.tables)"
            if target.cluster
            else "system.tables"
        )
        leftovers = target.admin.query(
            f"SELECT name FROM {tables} WHERE database = '{target.database}' "
            f"AND startsWith(name, '{project.table}__cutover_')"
        ).rows
        assert leftovers == [], f"the cutover must create nothing, found {leftovers}"
    finally:
        drop_cutover_project(target, project)


def run_created_outside_chkit_scenario(
    target: CutoverTarget,
    label: str,
    directory: Path,
    *,
    columns: str,
    schema_columns: list[dict[str, Any]],
    order_by: str = "id",
    clauses: str = "",
    settings: dict[str, Any] | None = None,
) -> None:
    """The table is created outside chkit with ``columns``, ``clauses`` after
    its ORDER BY and the query ``settings``, in a form the schema
    (``schema_columns``) describes but chkit would not write: the cutover must
    accept it. TS ``runCreatedOutsideChkitScenario``."""
    project = create_cutover_project(target, label, directory, schema_columns)
    try:
        fqn = f"{target.database}.{project.table}"
        _recreate_table(
            target,
            project,
            f"CREATE TABLE {fqn} ({columns}) ENGINE = {target.engine} ORDER BY {order_by}"
            + (f" {clauses}" if clauses else ""),
            settings,
        )
        target.admin.execute(
            f"INSERT INTO {fqn} (id, user_id, payload) "
            "SELECT number, number % 97, 'historic' FROM numbers(1000)"
        )

        _generate_cutover(target, project)
        expect_ok(cli(["migrate", "--apply", "--json"]), "migrate --apply (cutover)")
        assert sorting_keys(target, project)[project.table] == "user_id, id"
        total = rows(target, f"SELECT count() AS total FROM {target.rows_of(project.table)}")
        assert int(total[0]["total"]) == 1000
    finally:
        drop_cutover_project(target, project)


def run_stored_spelling_scenario(
    target: CutoverTarget, label: str, directory: Path, columns: list[dict[str, Any]]
) -> None:
    """The schema declares ``columns``, and chkit creates the table from it.
    ClickHouse stores some types in another spelling (``Decimal64(2)`` as
    ``Decimal(18, 2)``), and the cutover must still accept the unchanged table.
    TS ``runStoredSpellingScenario``."""
    project = create_cutover_project(target, label, directory, columns)
    try:
        _generate_cutover(target, project)
        expect_ok(cli(["migrate", "--apply", "--json"]), "migrate --apply (cutover)")
        assert sorting_keys(target, project)[project.table] == "user_id, id"
        total = rows(target, f"SELECT count() AS total FROM {target.rows_of(project.table)}")
        assert int(total[0]["total"]) == project.historic
        # No assert_chkit_clean: chkit drift reports Decimal64(2) against the stored
        # Decimal(18, 2) on its own.
    finally:
        drop_cutover_project(target, project)


def _retry_steps(
    blocks: list[str],
    types: list[str],
    drop_old: int,
    replayed: dict[int, str],
    failures: RetryFailures,
) -> list[int]:
    if failures == "layout guards":
        exchange = types.index("exchange_tables")
        return [exchange, exchange + 1, drop_old]

    def retry_runs_other_sql(step: int) -> bool:
        lines = blocks[step + 1].split("\n")
        return any(line.startswith("-- before-retry:") for line in lines) or " mode=async" in lines[0]

    return [step for step in range(len(types)) if retry_runs_other_sql(step) or step - 1 in replayed]


def _inject_failure(blocks: list[str], step: int) -> str:
    """Replace the SQL of operation ``step`` (0-based) with a statement that
    fails, keeping its marker lines. The server rejects it before it starts
    (an unknown identifier): an async step that fails while it runs may have
    applied writes, so it is never retried without an abandon (#767)."""
    out: list[str] = []
    for index, block in enumerate(blocks):
        if index != step + 1:
            out.append(block)
            continue
        comments = [line for line in block.split("\n") if line.startswith("--")]
        out.append(
            "\n".join([*comments, f"SELECT `injected failure at statement {step + 1}`;"])
        )
    return "\n\n".join(out)
