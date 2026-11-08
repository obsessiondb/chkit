"""On a database chkit migrated, pull then generate plans nothing and drift is clean (#466).

The journal table is not pulled, literal defaults read back as expressions,
every stored setting is pulled (index_granularity, floats in the form
ClickHouse stores), hidden minmax indexes are left out, and the LIFETIME forms
ClickHouse stores compare equal to the ones the schema declares.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    poll_until,
    quote_ident,
    resolve_live_env,
)


def test_pull_then_generate_plans_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    database = f"{create_prefix('pull_rt_py')}db"
    journal_table = create_journal_table_name("pull_rt_py")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.setenv("CI", "1")
    clickhouse = json.dumps({
        "url": env.clickhouse_url,
        "username": env.clickhouse_user,
        "password": env.clickhouse_password,
        "database": database,
    })
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n"
        # ObsessionDB writes storage_policy = 's3' into every Shared table; its
        # plugin gives the schema and the snapshot the same value.
        "from chkit_plugin_obsessiondb import obsessiondb\n\n"
        "config = define_config({\n"
        '    "schema": "./schema.py",\n'
        '    "outDir": "./chkit",\n'
        '    "migrationsDir": "./chkit/migrations",\n'
        '    "metaDir": "./chkit/meta",\n'
        f'    "clickhouse": {clickhouse},\n'
        '    "plugins": [obsessiondb()],\n'
        "})\n"
    )
    (tmp_path / "schema.py").write_text(f"""from chkit import dictionary, materialized_view, schema, table, view

db = {database!r}


def lookup(name, lifetime):
    return dictionary(
        database=db, name=name, primary_key=["k"], source="NULL()", layout="HASHED()",
        lifetime=lifetime,
        attributes=[{{"name": "k", "type": "UInt64"}}, {{"name": "v", "type": "String"}}],
    )


definitions = schema(
    table(
        database=db, name="events", engine="MergeTree()", primary_key=["id"], order_by=["id"],
        columns=[
            {{"name": "id", "type": "UInt64"}},
            {{"name": "n", "type": "UInt8", "default": 7}},
            {{"name": "source", "type": "String", "default": "web"}},
            {{"name": "quote", "type": "String", "default": "it's"}},
            {{"name": "multiline", "type": "String", "default": "x\\ny\\tz"}},
            {{"name": "ratio", "type": "Float64", "default": 2.0}},
            {{"name": "received_at", "type": "DateTime64(3)",
             "default": {{"expression": "now64(3)"}}}},
            # ClickHouse stores these types with its own spacing (Decimal(10, 2)).
            {{"name": "amount", "type": "Decimal(10,2)"}},
            {{"name": "at_utc", "type": "DateTime64(3,'UTC')"}},
            {{"name": "attrs", "type": "Map(String,UInt64)"}},
            {{"name": "kind", "type": "Enum8('a  b'=1,'c'=2)"}},
            {{"name": "maybe", "type": "Decimal(10,2)", "nullable": True}},
            # Defaults ClickHouse stores in another form (1e21) or a float cannot hold.
            {{"name": "huge", "type": "Float64", "default": 1e21}},
            {{"name": "tiny", "type": "Float64", "default": 1e-7}},
            {{"name": "max_u64", "type": "UInt64", "default": 18446744073709551615}},
        ],
    ),
    table(
        database=db, name="tuned", engine="MergeTree()", primary_key=["id"], order_by=["id"],
        columns=[{{"name": "id", "type": "UInt64"}}],
        settings={{"index_granularity": 4096, "merge_with_ttl_timeout": 3600}},
    ),
    table(
        database=db, name="minmax", engine="MergeTree()", primary_key=["id"], order_by=["id"],
        columns=[{{"name": "id", "type": "UInt64"}}, {{"name": "s", "type": "String"}}],
        settings={{
            "add_minmax_index_for_numeric_columns": 1,
            "merge_selecting_sleep_slowdown_factor": 2.0,
        }},
    ),
    table(
        database=db, name="daily", engine="MergeTree()", primary_key=["day"], order_by=["day"],
        columns=[{{"name": "day", "type": "Date"}}, {{"name": "c", "type": "UInt64"}}],
    ),
    view(database=db, name="recent", as_="SELECT id, n FROM {database}.events"),
    materialized_view(
        database=db, name="daily_mv", to={{"database": db, "name": "daily"}},
        as_="SELECT toDate(received_at) AS day, count() AS c FROM {database}.events GROUP BY day",
    ),
    lookup("lookup_300", "300"),
    lookup("lookup_min0", "MIN 0 MAX 300"),
    lookup("lookup_min10", "MIN 10 MAX 300"),
)
""")
    runner = CliRunner()

    def chkit(*args: str) -> Any:
        return runner.invoke(app, list(args))

    try:
        generated = chkit("generate", "--name", f"pull_rt_{database}", "--json")
        assert generated.exit_code == 0, format_test_diagnostic("chkit generate", generated)
        migrated = chkit("migrate", "--apply", "--json")
        assert migrated.exit_code == 0, format_test_diagnostic("chkit migrate --apply", migrated)

        # The replica that answers pull may not list every object yet.
        def pull() -> Any:
            return chkit(
                "pull", "--database", database, "--out-file", "pulled.py", "--force", "--json"
            )

        pulled = poll_until(
            pull,
            lambda result: result.exit_code == 0
            and json.loads(result.stdout)["definitionCount"] == 9,
        )
        assert pulled.exit_code == 0, format_test_diagnostic("chkit pull", pulled)
        assert json.loads(pulled.stdout)["definitionCount"] == 9
        pulled_content = (tmp_path / "pulled.py").read_text()
        assert journal_table not in pulled_content
        assert "index_granularity" in pulled_content
        assert "auto_minmax_index" not in pulled_content
        assert "Decimal(10, 2)" in pulled_content

        (tmp_path / "schema.py").write_text(pulled_content)
        plan = chkit("generate", "--dryrun", "--json")
        assert plan.exit_code == 0, format_test_diagnostic("chkit generate --dryrun", plan)
        assert json.loads(plan.stdout)["operations"] == []

        drift = chkit("drift", "--live", "--json")
        assert drift.exit_code == 0, format_test_diagnostic("chkit drift --live", drift)
        payload = json.loads(drift.stdout)
        assert payload["tableDrift"] == []
        assert payload["drifted"] is False
    finally:
        with ClickHouseClient.connect(
            ChxResolvedClickHouseConfig(
                url=env.clickhouse_url,
                username=env.clickhouse_user,
                password=env.clickhouse_password,
                database=env.clickhouse_database,
                secure=env.clickhouse_url.startswith("https:"),
            )
        ) as client:
            client.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")


def test_pull_uses_order_by_as_the_primary_key_a_table_does_not_declare(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On a table created without chkit, pull then drift is clean (#487)."""
    env = resolve_live_env()
    database = f"{create_prefix('pull_keys_py')}db"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", create_journal_table_name("pull_keys_py"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.setenv("CI", "1")
    clickhouse = json.dumps({
        "url": env.clickhouse_url,
        "username": env.clickhouse_user,
        "password": env.clickhouse_password,
        "database": database,
    })
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n"
        "from chkit_plugin_obsessiondb import obsessiondb\n\n"
        "config = define_config({\n"
        '    "schema": "./schema.py",\n'
        '    "outDir": "./chkit",\n'
        '    "migrationsDir": "./chkit/migrations",\n'
        '    "metaDir": "./chkit/meta",\n'
        f'    "clickhouse": {clickhouse},\n'
        '    "plugins": [obsessiondb()],\n'
        "})\n"
    )
    runner = CliRunner()

    def chkit(*args: str) -> Any:
        return runner.invoke(app, list(args))

    with ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    ) as client:
        try:
            client.execute(f"CREATE DATABASE {quote_ident(database)}")
            client.execute(
                f"CREATE TABLE {quote_ident(database)}.events (a UInt8, b UInt8) "
                "ENGINE = MergeTree ORDER BY (b, a)"
            )
            pulled = poll_until(
                lambda: chkit("pull", "--database", database, "--out-file", "schema.py", "--json"),
                lambda result: result.exit_code == 0
                and json.loads(result.stdout)["definitionCount"] == 1,
            )
            assert pulled.exit_code == 0, format_test_diagnostic("chkit pull", pulled)

            generated = chkit("generate", "--name", "baseline", "--json")
            assert generated.exit_code == 0, format_test_diagnostic("chkit generate", generated)
            drift = chkit("drift", "--json")
            assert json.loads(drift.stdout)["tableDrift"] == [], format_test_diagnostic(
                "chkit drift", drift
            )
        finally:
            client.execute(f"DROP DATABASE IF EXISTS {quote_ident(database)} SYNC")
