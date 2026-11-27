"""A materialized view's query change, end to end (#760).

Port of ``packages/cli/src/test/mv-modify-query.e2e.test.ts``: the same cases, through the CLI.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import clickhouse_connect  # type: ignore[import-untyped]
import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    live_env_to_client_kwargs,
    poll_until,
    quote_ident,
    resolve_live_env,
)


class _Project:
    def __init__(self, root: Path, database: str) -> None:
        self.runner = CliRunner()
        self.root = root
        self.database = database

    def invoke(self, args: list[str]) -> Any:
        return self.runner.invoke(app, args)

    def write_schema(self, events_columns: list[dict[str, str]], view_query: str) -> None:
        database = self.database
        events = {
            "database": database,
            "name": "events",
            "engine": "MergeTree()",
            "columns": events_columns,
            "order_by": ["ts"],
        }
        counts = {
            "database": database,
            "name": "counts",
            "engine": "SummingMergeTree()",
            "columns": [{"name": "kind", "type": "String"}, {"name": "events", "type": "UInt64"}],
            "order_by": ["kind"],
        }
        view = {
            "database": database,
            "name": "counts_mv",
            "to": {"database": database, "name": "counts"},
            "as_": view_query,
        }
        (self.root / "schema.py").write_text(
            "from chkit import materialized_view, schema, table\n\n"
            f"definitions = schema(table(**{events!r}), table(**{counts!r}), "
            f"materialized_view(**{view!r}))\n",
            encoding="utf-8",
        )

    def generate(self, name: str) -> None:
        generate = self.invoke(["generate", "--name", name, "--json"])
        assert generate.exit_code == 0, format_test_diagnostic(f"generate {name}", generate)

    def migrate(self, name: str, flags: list[str]) -> None:
        self.generate(name)
        migrate = self.invoke(["migrate", "--apply", *flags, "--json"])
        for _ in range(4):
            if migrate.exit_code == 0:
                break
            time.sleep(2)
            migrate = self.invoke(["migrate", "--apply", *flags, "--json"])
        assert migrate.exit_code == 0, format_test_diagnostic(f"migrate {name}", migrate)

    def plan_types(self) -> list[str]:
        plan = self.invoke(["generate", "--dryrun", "--json"])
        assert plan.exit_code == 0, format_test_diagnostic("generate --dryrun", plan)
        return [op["type"] for op in json.loads(plan.stdout)["operations"]]

    def assert_no_drift(self) -> None:
        drift = self.invoke(["drift", "--json"])
        assert drift.exit_code == 0, format_test_diagnostic("drift", drift)
        payload = json.loads(drift.stdout)
        assert payload["objectDrift"] == []
        assert payload["tableDrift"] == []
        assert payload["drifted"] is False


@pytest.fixture
def project(
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest
) -> Iterator[_Project]:
    env = resolve_live_env()
    label = request.node.name.removeprefix("test_")[:12]
    database = f"{create_prefix(f'mvq_py_{label}')}db"
    journal_table = create_journal_table_name("mvq_py")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.setenv("CI", "1")
    clickhouse = json.dumps(
        {
            "url": env.clickhouse_url,
            "username": env.clickhouse_user,
            "password": env.clickhouse_password,
            "database": env.clickhouse_database,
        }
    )
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\n"
        "config = define_config({\n"
        '    "schema": "./schema.py",\n'
        '    "outDir": "./chkit",\n'
        '    "migrationsDir": "./chkit/migrations",\n'
        '    "metaDir": "./chkit/meta",\n'
        f'    "clickhouse": {clickhouse},\n'
        "})\n"
    )
    try:
        yield _Project(tmp_path, database)
    finally:
        client = ch_client._client
        client.command(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
        client.command(
            f"DROP TABLE IF EXISTS {quote_ident(env.clickhouse_database)}."
            f"{quote_ident(journal_table)} SYNC"
        )


def _insert(client: Any, database: str, *kinds: str) -> None:
    # Replicated and Shared tables drop an insert whose block repeats an earlier
    # one (two clicks in the same second), so every insert is counted on its own.
    values = ", ".join(f"(now(), '{kind}')" for kind in kinds)
    client.command(
        f"INSERT INTO {quote_ident(database)}.events VALUES {values}",
        settings={"async_insert": 0, "insert_deduplicate": 0},
    )


def _target_counts(ch_client: Any, database: str) -> dict[str, int]:
    rows = ch_client._client.query(
        f"SELECT kind, sum(events) FROM {quote_ident(database)}.counts GROUP BY kind"
    ).result_rows
    return {str(kind): int(events) for kind, events in rows}


_LIVE_COLUMNS = [{"name": "ts", "type": "DateTime"}, {"name": "kind", "type": "String"}]


def test_query_only_change_keeps_view_feeding_target_while_migrate_runs(
    project: _Project, ch_client: Any
) -> None:
    database = project.database
    query = f"SELECT kind, count() AS events FROM {database}.events{{}} GROUP BY kind"
    client = ch_client._client
    project.write_schema(_LIVE_COLUMNS, query.format(""))
    project.migrate("init", [])
    _insert(client, database, "click", "heartbeat")

    project.write_schema(_LIVE_COLUMNS, query.format(" WHERE kind != 'heartbeat'"))
    assert project.plan_types() == ["alter_materialized_view_modify_query"]
    project.generate("filter")

    finished = threading.Event()
    clicks_during_migrate = 0

    def insert_until_finished() -> None:
        nonlocal clicks_during_migrate
        inserter = clickhouse_connect.get_client(**live_env_to_client_kwargs(resolve_live_env()))
        try:
            while not finished.is_set():
                _insert(inserter, database, "click")
                clicks_during_migrate += 1
        finally:
            inserter.close()

    thread = threading.Thread(target=insert_until_finished)
    thread.start()
    try:
        migrate = project.invoke(["migrate", "--apply", "--json"])
    finally:
        finished.set()
        thread.join()
    assert migrate.exit_code == 0, format_test_diagnostic("migrate filter", migrate)
    assert clicks_during_migrate > 0
    _insert(client, database, "click", "heartbeat")

    expected = {"click": clicks_during_migrate + 2, "heartbeat": 1}
    counted = poll_until(lambda: _target_counts(ch_client, database), lambda c: c == expected)
    assert counted == expected
    project.assert_no_drift()


def test_new_query_reading_added_column_and_not_dropped_one_migrates_in_place(
    project: _Project, ch_client: Any
) -> None:
    database = project.database
    project.write_schema(
        [{"name": "ts", "type": "DateTime"}, {"name": "legacy_kind", "type": "String"}],
        f"SELECT legacy_kind AS kind, count() AS events FROM {database}.events GROUP BY kind",
    )
    project.migrate("init", [])
    _insert(ch_client._client, database, "click")

    project.write_schema(
        [{"name": "ts", "type": "DateTime"}, {"name": "kind", "type": "LowCardinality(String)"}],
        f"SELECT kind, count() AS events FROM {database}.events "
        "WHERE kind != 'heartbeat' GROUP BY kind",
    )
    assert sorted(project.plan_types()) == [
        "alter_materialized_view_modify_query",
        "alter_table_add_column",
        "alter_table_drop_column",
    ]
    project.migrate("switch", ["--allow-destructive"])
    _insert(ch_client._client, database, "view", "heartbeat")

    expected = {"click": 1, "view": 1}
    counted = poll_until(lambda: _target_counts(ch_client, database), lambda c: c == expected)
    assert counted == expected
    project.assert_no_drift()
