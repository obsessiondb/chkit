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
from typing import Any

from typer.testing import CliRunner

from chkit.cli.commands.migrate_async_apply import iso_without_zone
from chkit.cli.journal_store import JournalStore, MigrationRowState
from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    wait_for_table_on_every_replica,
)

HISTORIC_ROWS = 20_000
BATCH_ROWS = 200


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


@dataclass
class WriterReport:
    batches: int = 0
    rows: int = 0
    errors: list[str] = field(default_factory=list)


@dataclass
class CliOutcome:
    exit_code: int
    stdout: str
    output: str


def create_cutover_project(
    target: CutoverTarget, label: str, directory: Path
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
    JournalStore(target.admin, target.cluster)._ensure_table()
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


def write_schema(target: CutoverTarget, project: CutoverProject, order_by: list[str]) -> None:
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

events = table(database={db!r}, name={project.table!r}, engine={engine!r}, columns=columns,
               primary_key={order_by!r}, order_by={order_by!r})
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
    Only batches that succeeded count."""

    def __init__(self, target: CutoverTarget, project: CutoverProject, parallel: int = 2) -> None:
        self._target = target
        self._project = project
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
                client = clients[batch % len(clients)]
                into = self._project.table if batch % 2 == 0 else self._project.ingest
                start = 1_000_000_000 + batch * BATCH_ROWS
                try:
                    client.execute(
                        f"INSERT INTO {db}.{into} (id, user_id, payload) SELECT {start} + number, "
                        f"number % 97, 'live-{worker}' FROM numbers({BATCH_ROWS})"
                    )
                    with self._lock:
                        self.report.batches += 1
                        self.report.rows += BATCH_ROWS
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


def sorting_keys(target: CutoverTarget, project: CutoverProject) -> dict[str, str]:
    result = target.admin.query(
        "SELECT name, sorting_key FROM system.tables "
        f"WHERE database = '{target.database}' AND (name IN ('{project.table}', "
        f"'{project.previous}') OR startsWith(name, '{project.table}__cutover_')) ORDER BY name"
    ).rows
    return {str(row["name"]): str(row["sorting_key"]).strip("()") for row in result}


def assert_chkit_clean() -> None:
    """status, drift (schema and live), check (schema and live) and generate
    --dryrun report nothing to do."""
    status = json_of(cli(["status", "--json"]), "status")
    drift = json_of(cli(["drift", "--json"]), "drift")
    live = json_of(cli(["drift", "--live", "--json"]), "drift --live")
    check = cli(["check", "--live", "--json"])
    plan = json_of(cli(["generate", "--dryrun", "--json"]), "generate --dryrun")
    summary = {
        "pending": status["pending"],
        "drifted": drift["drifted"],
        "live_drifted": live["drifted"],
        "live_missing": live["missing"],
        "check": check.exit_code,
        "operations": plan["operationCount"],
    }
    assert summary == {
        "pending": 0,
        "drifted": False,
        "live_drifted": False,
        "live_missing": [],
        "check": 0,
        "operations": 0,
    }, f"chkit not clean after the cutover: {summary}\n{_without_extra(live)}\n{check.output}"


def _without_extra(payload: dict[str, Any]) -> str:
    return json.dumps({key: value for key, value in payload.items() if key != "extra"})


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


def _generate_cutover(target: CutoverTarget, project: CutoverProject, *flags: str) -> dict[str, Any]:
    write_schema(target, project, ["user_id", "id"])
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


def run_keep_scenario(target: CutoverTarget, label: str, directory: Path) -> None:
    """The default cutover: copy inside the migration, old table kept as
    ``<table>_previous``, while writers insert the whole time."""
    project = create_cutover_project(target, label, directory)
    try:
        generated = _generate_cutover(target, project)
        assert generated["riskSummary"]["danger"] == 0
        assert generated["cutovers"][0]["retainedAs"] == f"{target.database}.{project.previous}"

        writers = Writers(target, project)
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
        if target.settle is not None:
            target.settle([project.previous])
        previous = rows(
            target,
            f"SELECT count() AS total, uniqExact(id) AS ids FROM {target.rows_of(project.previous)}",
        )[0]
        assert int(previous["total"]) == int(previous["ids"]) >= project.historic, previous
        assert_chkit_clean()
    finally:
        drop_cutover_project(target, project)


def run_backfill_scenario(target: CutoverTarget, label: str, directory: Path) -> None:
    """The backfill copy: migrate stops at the copy check, the backfill plugin
    copies the snapshot, and the next apply verifies and swaps. The old table
    is dropped."""
    project = create_cutover_project(target, label, directory)
    fqn = f"{target.database}.{project.table}"
    try:
        _generate_cutover(target, project, "--cutover-copy", "backfill", "--cutover-old", "drop")
        writers = Writers(target, project)
        try:
            stopped = cli(["migrate", "--apply", "--allow-destructive", "--json"])
            assert stopped.exit_code == 1, stopped.output
            assert f"chkit plugin backfill plan --cutover {fqn}" in stopped.output, stopped.output
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
        assert_chkit_clean()
    finally:
        drop_cutover_project(target, project)


def run_retry_scenario(target: CutoverTarget, label: str, directory: Path) -> None:
    """Fail every statement of the cutover once and resume it with --retry, and
    replay the statements whose acknowledgement can be lost: the snapshot
    (re-taken after a TRUNCATE), the copy (skips what it wrote), the EXCHANGE
    (refuses: it must never swap back) and the drop of the old table. Writers
    insert the whole time; no row may be lost or duplicated."""
    project = create_cutover_project(target, label, directory)
    writers: Writers | None = None
    try:
        _generate_cutover(target, project, "--cutover-old", "drop")
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

        for step in range(len(types)):
            path.write_text(_inject_failure(blocks, step), encoding="utf-8")
            failed = migrate(retry=step > 0)
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
                keys = sorting_keys(target, project)
                assert keys[project.table] == "user_id, id", f"swapped back: {keys}"
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
        assert sorting_keys(target, project) == {project.table: "user_id, id"}
        assert_chkit_clean()
    finally:
        if writers is not None:
            writers.stop()
        drop_cutover_project(target, project)


def _inject_failure(blocks: list[str], step: int) -> str:
    """Replace the SQL of operation ``step`` (0-based) with a statement that
    fails, keeping its marker lines."""
    out: list[str] = []
    for index, block in enumerate(blocks):
        if index != step + 1:
            out.append(block)
            continue
        comments = [line for line in block.split("\n") if line.startswith("--")]
        out.append(
            "\n".join([*comments, f"SELECT throwIf(1, 'injected failure at statement {step + 1}');"])
        )
    return "\n\n".join(out)
