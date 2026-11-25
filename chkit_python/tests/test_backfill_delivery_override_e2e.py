"""Port of ``packages/cli/src/test/backfill-delivery-override.e2e.test.ts`` (#821).

``distributed_foreground_insert = 1`` is a default, not a pin a user cannot
change. A user who sets ``distributed_foreground_insert = 0`` in
``backfill({"insertSettings": ...})`` gets it in the chunk INSERT: the chunk
is done while its rows still sit in the distribution queue, and the run
prints one warning naming what is off.

The backfill is an mv_replay into a Distributed table over the local stack's
one-node ``cluster`` (test/infra/clickhouse.xml), planned and run through the
CLI. That cluster writes its local shard in place, so the user's
insertSettings also set ``prefer_localhost_replica = 0``, and delivery is
stopped: rows that go through the queue stay in it.

ObsessionDB has no shards and no Distributed grant, so there the view writes
to a plain table, and the run only shows the override is accepted and warned
about.

Requires a reachable ClickHouse (see ``tests/e2e_testkit.py``). Hard-fails when
the server is unreachable; never skips.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_table
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import create_prefix, poll_until, quote_ident, resolve_live_env

ON_OBSESSIONDB = os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb"
SOURCE_ROWS = 1000
WARNING = (
    "Warning: insertSettings overrides what every backfill chunk INSERT sets by default: "
    "distributed_foreground_insert=0 (a chunk can be recorded done before its rows reach "
    "a Distributed table's shards)."
)

CONFIG_TEMPLATE = """
from chkit import define_config
from chkit_plugin_backfill import backfill

config = define_config(
    {{
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "clickhouse": {{
            "url": {url!r},
            "username": {user!r},
            "password": {password!r},
            "database": {database!r},
        }},
        "plugins": [backfill({{"insertSettings": {insert_settings!r}}})],
    }}
)
"""


def _count_rows(db: ClickHouseClient, fqn: str) -> int:
    rows = db.query(
        f"SELECT toString(count()) AS cnt FROM {fqn} SETTINGS select_sequential_consistency = 1"
    ).rows
    return int(str(rows[0]["cnt"]))


def test_distributed_foreground_insert_0_from_insert_settings_leaves_a_done_chunk_queued(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    config = ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=env.clickhouse_url.startswith("https"),
    )
    try:
        db = ClickHouseClient.connect(config)
        db.query("SELECT 1")
    except Exception as exc:  # never skip on an unreachable server
        pytest.fail(f"ClickHouse unreachable at {env.clickhouse_url}: {exc!r}", pytrace=False)

    database = env.clickhouse_database
    prefix = create_prefix("bf_override")
    target = "local" if ON_OBSESSIONDB else "dist"

    def fqn(table: str) -> str:
        return f"{quote_ident(database)}.{quote_ident(prefix + table)}"

    try:
        for table in ("source", "local"):
            db.execute(
                f"CREATE TABLE {fqn(table)} (id UInt64, event_time DateTime) ENGINE = MergeTree() "
                "PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)"
            )
            wait_for_table(db, database, prefix + table)
        if not ON_OBSESSIONDB:
            db.execute(
                f"CREATE TABLE {fqn('dist')} AS {fqn('local')} ENGINE = Distributed(cluster, "
                f"{quote_ident(database)}, {quote_ident(prefix + 'local')}, rand())"
            )
            db.execute(f"SYSTEM STOP DISTRIBUTED SENDS {fqn('dist')}")
        db.execute(
            f"INSERT INTO {fqn('source')} SELECT number, toDateTime('2026-01-01 12:00:00') "
            f"FROM numbers({SOURCE_ROWS})"
        )
        assert (
            poll_until(lambda: _count_rows(db, fqn("source")), lambda rows: rows == SOURCE_ROWS)
            == SOURCE_ROWS
        )

        # The view is never created: the replay reads its query from the schema.
        (tmp_path / "schema.py").write_text(
            f"""
from chkit import materialized_view, schema

definitions = schema(
    materialized_view(
        database={database!r},
        name={prefix + "mv"!r},
        to={{"database": {database!r}, "name": {prefix + target!r}}},
        as_={f"SELECT id, event_time FROM {database}.{prefix}source"!r},
    )
)
""",
            encoding="utf-8",
        )
        insert_settings: dict[str, int] = (
            {"distributed_foreground_insert": 0}
            if ON_OBSESSIONDB
            else {"distributed_foreground_insert": 0, "prefer_localhost_replica": 0}
        )
        (tmp_path / "clickhouse.config.py").write_text(
            CONFIG_TEMPLATE.format(
                url=env.clickhouse_url,
                user=env.clickhouse_user,
                password=env.clickhouse_password,
                database=database,
                insert_settings=insert_settings,
            ),
            encoding="utf-8",
        )
        monkeypatch.chdir(tmp_path)
        runner = CliRunner()

        plan = runner.invoke(
            app, ["plugin", "backfill", "plan", "--target", f"{database}.{prefix}{target}", "--json"]
        )
        assert plan.exit_code == 0, plan.output
        planned = json.loads(plan.stdout)
        assert planned["strategy"] == "mv_replay"

        run = runner.invoke(
            app,
            ["plugin", "backfill", "run", "--plan-id", planned["planId"],
             "--poll-interval", "500", "--json"],
        )
        assert run.exit_code == 0, run.output
        assert json.loads(run.stdout)["status"] == "completed"
        warnings = [
            line for line in run.stderr.splitlines() if line.startswith("Warning: insertSettings")
        ]
        assert warnings == [WARNING]

        if ON_OBSESSIONDB:
            assert (
                poll_until(lambda: _count_rows(db, fqn("local")), lambda rows: rows == SOURCE_ROWS)
                == SOURCE_ROWS
            )
        else:
            queue = db.query(
                "SELECT toString(sum(data_files)) AS files FROM system.distribution_queue "
                f"WHERE database = '{database}' AND table = '{prefix}dist'"
            ).rows
            files = int(str(queue[0]["files"])) if queue else 0
            assert files > 0, "files queued for background delivery once the chunk is done"
            assert _count_rows(db, fqn("local")) == 0, "rows on the shard while delivery is stopped"
    finally:
        for table in ("dist", "local", "source"):
            db.execute(f"DROP TABLE IF EXISTS {fqn(table)} SYNC")
        db.close()
