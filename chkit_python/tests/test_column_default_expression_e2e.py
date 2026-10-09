"""Port of ``packages/cli/src/test/column-default-expression.e2e.test.ts`` (#234).

``SQLExpression`` defaults of every kind migrate as SQL, fill inserted rows,
add columns, and read as no drift.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.core.sql_splitter import extract_executable_statements
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    quote_ident,
    resolve_live_env,
)

# `seen_at` and `day` are not the last column: rendered with its comment, the
# `--` would swallow the comma before the next column and the CREATE would fail.
CREATE_COLUMNS = [
    "{'name': 'id', 'type': 'UInt64'}",
    "{'name': 'updated_at', 'type': \"DateTime64(3, 'UTC')\", "
    "'default': SQLExpression(expression='now64(3)')}",
    "{'name': 'day', 'type': 'Date', 'default_kind': 'MATERIALIZED', "
    "'default': {'expression': 'toDate(updated_at) -- day of the update'}}",
    "{'name': 'seen_at', 'type': 'DateTime', 'nullable': True, "
    "'default': {'expression': 'now() -- set on insert'}}",
    "{'name': 'status', 'type': 'String', 'default': 'new'}",
]

# Adds three expression columns, one with a trailing comment that would
# swallow its statement's `;` and one ALIAS, and switches updated_at and day to
# the legacy fn: spelling, which must plan nothing.
ALTER_COLUMNS = [
    "{'name': 'id', 'type': 'UInt64'}",
    "{'name': 'updated_at', 'type': \"DateTime64(3, 'UTC')\", 'default': 'fn:now64(3)'}",
    "{'name': 'day', 'type': 'Date', 'default_kind': 'MATERIALIZED', "
    "'default': 'fn: toDate(updated_at) -- day of the update'}",
    "{'name': 'seen_at', 'type': 'DateTime', 'nullable': True, "
    "'default': {'expression': 'now() -- set on insert'}}",
    "{'name': 'status', 'type': 'String', 'default': 'new'}",
    "{'name': 'added_at', 'type': 'DateTime', 'default': {'expression': 'now() -- added later'}}",
    "{'name': 'added_n', 'type': 'UInt8', 'default': {'expression': 'toUInt8(1)'}}",
    "{'name': 'label', 'type': 'String', 'default_kind': 'ALIAS', "
    "'default': {'expression': \"concat('id-', toString(id))\"}}",
]


def _render_schema(database: str, table_name: str, columns: list[str]) -> str:
    return "\n".join([
        "from chkit import SQLExpression, schema, table",
        "",
        "definitions = schema(",
        f"    table(database={database!r}, name={table_name!r}, engine='MergeTree()', "
        "primary_key=['id'], order_by=['id'], columns=[",
        *(f"        {column}," for column in columns),
        "    ]),",
        ")",
        "",
    ])


def _wait_for_rows(client: Any, sql: str, done: Any, timeout: float = 60) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout
    rows = list(client.query(sql).named_results())
    while not done(rows) and time.monotonic() < deadline:
        time.sleep(1)
        rows = list(client.query(sql).named_results())
    return rows


def test_sql_expression_defaults_migrate_fill_rows_add_columns_and_show_no_drift(  # noqa: PLR0915
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = ch_client._client
    env = resolve_live_env()
    database = client.database
    table_name = f"{create_prefix('expr_default')}events"
    journal_table = create_journal_table_name("expr_default_py")
    obj = f"{quote_ident(database)}.{quote_ident(table_name)}"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    runner = CliRunner()
    schema_path = tmp_path / "schema.py"
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\n\nconfig = define_config("
        + json.dumps({
            "schema": "./schema.py",
            "outDir": "./chkit",
            "migrationsDir": "./chkit/migrations",
            "metaDir": "./chkit/meta",
            "clickhouse": {
                "url": env.clickhouse_url,
                "username": env.clickhouse_user,
                "password": env.clickhouse_password,
                "database": database,
            },
        })
        + ")\n"
    )

    def generate(args: list[str]) -> dict[str, Any]:
        result = runner.invoke(app, ["generate", *args, "--json"])
        assert result.exit_code == 0, format_test_diagnostic("generate failed", result)
        return dict(json.loads(result.stdout))

    def migrate() -> None:
        result = runner.invoke(app, ["migrate", "--execute", "--json"])
        for _ in range(2):
            if result.exit_code == 0:
                break
            time.sleep(2)
            result = runner.invoke(app, ["migrate", "--execute", "--json"])
        assert result.exit_code == 0, format_test_diagnostic("migrate --execute failed", result)

    def expect_no_drift() -> None:
        result = runner.invoke(
            app, ["drift", "--live", "--table", f"{database}.{table_name}", "--json"]
        )
        assert result.exit_code == 0, format_test_diagnostic("drift failed", result)
        payload = json.loads(result.stdout)
        assert payload["tableDrift"] == []
        assert payload["drifted"] is False

    def column_defaults(count: int) -> list[dict[str, Any]]:
        return _wait_for_rows(
            client,
            "SELECT name, default_kind, default_expression FROM system.columns "
            f"WHERE database = '{database}' AND table = '{table_name}' ORDER BY name",
            lambda rows: len(rows) == count,
        )

    try:
        # 1. CREATE TABLE renders each expression as SQL, without its comment.
        schema_path.write_text(_render_schema(database, table_name, CREATE_COLUMNS))
        created = generate(["--name", "expr_default"])
        assert created["migrationFile"]
        create_sql = Path(created["migrationFile"]).read_text()
        assert "`updated_at` DateTime64(3, 'UTC') DEFAULT now64(3)," in create_sql
        assert "`day` Date MATERIALIZED toDate(updated_at)," in create_sql
        assert "`seen_at` Nullable(DateTime) DEFAULT now()," in create_sql
        assert "`status` String DEFAULT 'new'" in create_sql
        assert "DEFAULT 'now64(3)'" not in create_sql
        assert "set on insert" not in create_sql
        assert "day of the update" not in create_sql

        migrate()
        assert column_defaults(5) == [
            {"name": "day", "default_kind": "MATERIALIZED", "default_expression": "toDate(updated_at)"},
            {"name": "id", "default_kind": "", "default_expression": ""},
            {"name": "seen_at", "default_kind": "DEFAULT", "default_expression": "now()"},
            {"name": "status", "default_kind": "DEFAULT", "default_expression": "'new'"},
            {"name": "updated_at", "default_kind": "DEFAULT", "default_expression": "now64(3)"},
        ]

        # 2. ClickHouse evaluates the expressions: not the epoch, not NULL.
        client.command(f"INSERT INTO {obj} (id) VALUES (1)")
        [inserted] = _wait_for_rows(
            client,
            "SELECT status, toString(isNotNull(seen_at)) AS seen_set, "
            "toString(updated_at > toDateTime64('2020-01-01 00:00:00', 3, 'UTC')) AS updated_recent, "
            f"toString(day = toDate(updated_at)) AS day_matches FROM {obj}",
            lambda rows: len(rows) == 1,
        )
        assert inserted == {"status": "new", "seen_set": "1", "updated_recent": "1", "day_matches": "1"}

        # 3. The snapshot holds fn: strings; the live table matches them.
        expect_no_drift()

        # 4. ADD COLUMN with expression defaults; the spelling switch plans nothing.
        schema_path.write_text(_render_schema(database, table_name, ALTER_COLUMNS))
        planned = generate(["--dryrun"])
        assert [(op["type"], op["key"]) for op in planned["operations"]] == [
            ("alter_table_add_column", f"table:{database}.{table_name}:column:added_at"),
            ("alter_table_add_column", f"table:{database}.{table_name}:column:added_n"),
            ("alter_table_add_column", f"table:{database}.{table_name}:column:label"),
        ]
        altered = generate(["--name", "expr_default_add"])
        assert altered["migrationFile"]
        alter_sql = Path(altered["migrationFile"]).read_text()
        assert len(extract_executable_statements(alter_sql)) == 3
        assert "ADD COLUMN IF NOT EXISTS `added_at` DateTime DEFAULT now();" in alter_sql
        assert (
            "ADD COLUMN IF NOT EXISTS `label` String ALIAS concat('id-', toString(id));" in alter_sql
        )
        assert "added later" not in alter_sql

        migrate()
        assert column_defaults(8) == [
            {"name": "added_at", "default_kind": "DEFAULT", "default_expression": "now()"},
            {"name": "added_n", "default_kind": "DEFAULT", "default_expression": "toUInt8(1)"},
            {"name": "day", "default_kind": "MATERIALIZED", "default_expression": "toDate(updated_at)"},
            {"name": "id", "default_kind": "", "default_expression": ""},
            {"name": "label", "default_kind": "ALIAS",
             "default_expression": "concat('id-', toString(id))"},
            {"name": "seen_at", "default_kind": "DEFAULT", "default_expression": "now()"},
            {"name": "status", "default_kind": "DEFAULT", "default_expression": "'new'"},
            {"name": "updated_at", "default_kind": "DEFAULT", "default_expression": "now64(3)"},
        ]

        client.command(f"INSERT INTO {obj} (id) VALUES (2)")
        rows = _wait_for_rows(
            client,
            "SELECT toString(id) AS id, toString(added_n) AS added_n, "
            "toString(added_at > toDateTime('2020-01-01 00:00:00')) AS added_recent, label "
            f"FROM {obj} ORDER BY id",
            lambda result: len(result) == 2,
        )
        assert rows == [
            {"id": "1", "added_n": "1", "added_recent": "1", "label": "id-1"},
            {"id": "2", "added_n": "1", "added_recent": "1", "label": "id-2"},
        ]

        # 5. Still no drift, and the snapshot round-trips with nothing to plan.
        expect_no_drift()
        assert generate(["--dryrun"])["operations"] == []
    finally:
        client.command(f"DROP TABLE IF EXISTS {obj}")
        client.command(f"DROP TABLE IF EXISTS {quote_ident(database)}.{quote_ident(journal_table)}")
