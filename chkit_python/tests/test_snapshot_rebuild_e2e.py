"""Port of ``packages/cli/src/test/snapshot-rebuild.e2e.test.ts`` (#235).

Two branches each generate and apply a migration; their snapshots merge with
conflict markers. ``chkit snapshot rebuild`` must write view entries that match
the views ClickHouse holds after both migrations ran, leaving nothing to plan.

Runs the CLI in-process against the server in ``CLICKHOUSE_URL`` /
``CLICKHOUSE_HOST``; an unreachable server fails the test.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner, Result

from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_table, wait_for_view
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    get_required_env,
    quote_ident,
)

_POLL_TIMEOUT_SECONDS = 90.0


def test_rebuilt_snapshot_matches_the_views_two_merged_branches_left_in_clickhouse(  # noqa: PLR0915
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = get_required_env()
    database = env.clickhouse_database
    journal_table = create_journal_table_name("snaprb")
    prefix = create_prefix("snaprb")
    events_table = f"{prefix}events"
    events_view = f"{prefix}v_events"
    users_table = f"{prefix}users"
    users_view = f"{prefix}v_users"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CI", "1")
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    config_path = tmp_path / "clickhouse.config.py"
    base_schema_path = tmp_path / "src" / "base.py"
    snapshot_path = tmp_path / "chkit" / "meta" / "snapshot.json"
    main_view_sql = f"SELECT id FROM {database}.{events_table}"
    branch_a_view_sql = f"SELECT id, source FROM {database}.{events_table}"

    def render_base(view_sql: str) -> str:
        return (
            "from chkit import schema, table, view\n\n"
            f'events = table(database="{database}", name="{events_table}", '
            'columns=[{"name": "id", "type": "UInt64"}, {"name": "source", "type": "String"}], '
            'engine="MergeTree()", primary_key=["id"], order_by=["id"])\n'
            f'events_view = view(database="{database}", name="{events_view}", as_="{view_sql}")\n\n'
            "definitions = schema(events, events_view)\n"
        )

    branch_b_schema = (
        "from chkit import schema, table, view\n\n"
        f'users = table(database="{database}", name="{users_table}", '
        'columns=[{"name": "id", "type": "UInt64"}], engine="MergeTree()", '
        'primary_key=["id"], order_by=["id"])\n'
        f'users_view = view(database="{database}", name="{users_view}", '
        f'as_="SELECT id FROM {database}.{users_table}")\n\n'
        "definitions = schema(users, users_view)\n"
    )

    def chkit(args: list[str]) -> Result:
        return CliRunner().invoke(app, [*args, "--config", str(config_path)])

    def generate(name: str, migration_id: str) -> None:
        result = chkit(["generate", "--name", name, "--migration-id", migration_id, "--json"])
        assert result.exit_code == 0, format_test_diagnostic(f"generate {name} failed", result)

    def migrate() -> None:
        result = chkit(["migrate", "--execute", "--json"])
        assert result.exit_code == 0, format_test_diagnostic("migrate --execute failed", result)

    (tmp_path / "src").mkdir()
    config_path.write_text(
        "from chkit import define_config\n\n"
        "config = define_config({\n"
        f'    "schema": "{tmp_path}/src/*.py",\n'
        f'    "outDir": "{tmp_path}/chkit",\n'
        f'    "migrationsDir": "{tmp_path}/chkit/migrations",\n'
        f'    "metaDir": "{tmp_path}/chkit/meta",\n'
        '    "clickhouse": {\n'
        f'        "url": "{env.clickhouse_url}",\n'
        f'        "username": "{env.clickhouse_user}",\n'
        f'        "password": "{env.clickhouse_password}",\n'
        f'        "database": "{database}",\n'
        "    },\n"
        "})\n",
        encoding="utf-8",
    )
    client = ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    )

    try:
        # main: a table and a view over it, applied.
        base_schema_path.write_text(render_base(main_view_sql), encoding="utf-8")
        generate("base", "20260101000000")
        migrate()
        wait_for_view(client, database, events_view)
        main_snapshot = snapshot_path.read_text(encoding="utf-8")

        # Branch A changes the view; its migration is applied.
        base_schema_path.write_text(render_base(branch_a_view_sql), encoding="utf-8")
        generate("change_view", "20260102000000")
        migrate()
        branch_a_snapshot = snapshot_path.read_text(encoding="utf-8")

        # Branch B starts from main, adds a table and a view; its migration is applied too.
        base_schema_path.write_text(render_base(main_view_sql), encoding="utf-8")
        snapshot_path.write_text(main_snapshot, encoding="utf-8")
        (tmp_path / "src" / "b.py").write_text(branch_b_schema, encoding="utf-8")
        generate("add_users", "20260103000000")
        migrate()
        wait_for_table(client, database, users_table)
        wait_for_view(client, database, users_view)
        branch_b_snapshot = snapshot_path.read_text(encoding="utf-8")

        # The merge: both branches' schema files, and a snapshot git could not merge.
        base_schema_path.write_text(render_base(branch_a_view_sql), encoding="utf-8")
        snapshot_path.write_text(
            f"<<<<<<< HEAD\n{branch_a_snapshot}=======\n{branch_b_snapshot}>>>>>>> branch-b\n",
            encoding="utf-8",
        )

        blocked = chkit(["migrate", "--json"])
        assert blocked.exit_code == 1
        envelope = json.loads(blocked.stdout)
        assert envelope["ok"] is False
        blocked_message = envelope["error"]["message"]
        assert "contains unresolved merge conflict markers" in blocked_message
        assert "chkit snapshot rebuild" in blocked_message

        rebuild = chkit(["snapshot", "rebuild", "--json"])
        assert rebuild.exit_code == 0, format_test_diagnostic("snapshot rebuild failed", rebuild)
        payload = json.loads(rebuild.stdout)
        assert payload["written"] is True
        assert payload["definitionCount"] == 4
        assert payload["previous"] == {"status": "conflicted"}

        # The rebuilt view entries match the view definitions ClickHouse holds.
        rebuilt = json.loads(snapshot_path.read_text(encoding="utf-8"))

        def rebuilt_sql(name: str) -> str:
            for definition in rebuilt["definitions"]:
                if definition["kind"] == "view" and definition["name"] == name:
                    return str(definition.get("as", ""))
            return ""

        assert rebuilt_sql(events_view) == branch_a_view_sql
        for name in (events_view, users_view):
            expected = rebuilt_sql(name)
            live_sql = _poll_until(
                lambda name=name: _read_as_select(client, database, name),
                lambda value, expected=expected: value == expected,
            )
            assert live_sql == expected

        plan = chkit(["generate", "--dryrun", "--json"])
        assert plan.exit_code == 0, format_test_diagnostic("generate --dryrun failed", plan)
        assert json.loads(plan.stdout)["operationCount"] == 0

        drift = _poll_until(
            lambda: json.loads(chkit(["drift", "--json"]).stdout),
            lambda value: value.get("drifted") is False,
        )
        assert drift["drifted"] is False
        assert drift.get("missing", []) == []

        pending = chkit(["migrate", "--json"])
        assert pending.exit_code == 0, format_test_diagnostic("migrate --json failed", pending)
        assert json.loads(pending.stdout)["pending"] == []
    finally:
        db = quote_ident(database)
        for view in (events_view, users_view):
            client.execute(f"DROP VIEW IF EXISTS {db}.{quote_ident(view)}")
        for table in (events_table, users_table, journal_table):
            client.execute(f"DROP TABLE IF EXISTS {db}.{quote_ident(table)}")
        client.close()


def _read_as_select(client: ClickHouseClient, database: str, name: str) -> str:
    rows = client.query(
        "SELECT as_select FROM system.tables "
        f"WHERE database = '{database}' AND name = '{name}'"
    ).rows
    return str(rows[0]["as_select"]) if rows else ""


def _poll_until(read: Callable[[], Any], done: Callable[[Any], bool]) -> Any:
    """State-based poll: ObsessionDB DDL is eventually consistent."""
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    value = read()
    while not done(value) and time.monotonic() < deadline:
        time.sleep(1.0)
        value = read()
    return value
