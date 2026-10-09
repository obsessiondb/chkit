"""Port of ``packages/cli/src/test/generate-dependency-order.test.ts`` (#231)."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app


def render_schema(*, table: str, base_sql: str, top_sql: str, renamed_from: str | None = None) -> str:
    renamed = f"    renamed_from={{'name': '{renamed_from}'}},\n" if renamed_from else ""
    return (
        "from chkit import schema, table, view\n\n"
        f"source = table(\n    database='app',\n    name='{table}',\n{renamed}"
        "    columns=[{'name': 'id', 'type': 'UInt64'}],\n    engine='MergeTree()',\n"
        "    primary_key=['id'],\n    order_by=['id'],\n)\n\n"
        f"z_base = view(database='app', name='z_base', as_='{base_sql}')\n"
        f"a_top = view(database='app', name='a_top', as_='{top_sql}')\n\n"
        "definitions = schema(source, z_base, a_top)\n"
    )


def test_creates_a_view_after_the_view_it_reads_including_with_a_rename(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(
        'from chkit import define_config\n\nconfig = define_config({"schema": "./schema.py", '
        '"outDir": "./chkit", "migrationsDir": "./chkit/migrations", "metaDir": "./chkit/meta"})\n'
    )
    (tmp_path / "schema.py").write_text(
        render_schema(table="users", base_sql="SELECT id FROM app.users",
                      top_sql="SELECT id FROM app.z_base")
    )
    init = CliRunner().invoke(
        app, ["generate", "--name", "init", "--migration-id", "20260101000000", "--json"]
    )
    assert init.exit_code == 0, init.output
    init_sql = (tmp_path / "chkit" / "migrations" / "20260101000000_init.sql").read_text()
    assert re.findall(r"^-- operation: .*$", init_sql, re.MULTILINE) == [
        "-- operation: create_database key=database:app risk=safe",
        "-- operation: create_table key=table:app.users risk=safe",
        "-- operation: create_view key=view:app.z_base risk=safe",
        "-- operation: create_view key=view:app.a_top risk=safe",
    ]

    (tmp_path / "schema.py").write_text(
        render_schema(
            table="customers",
            renamed_from="users",
            base_sql="SELECT id FROM app.customers",
            top_sql="SELECT id FROM app.z_base WHERE id > 0",
        )
    )
    plan = CliRunner().invoke(app, ["generate", "--dryrun", "--json"])
    assert plan.exit_code == 0, plan.output
    payload = json.loads(plan.stdout)
    assert [f"{op['type']} {op['key']}" for op in payload["operations"]] == [
        "drop_view view:app.a_top",
        "drop_view view:app.z_base",
        "alter_table_rename_table table:app.customers:rename_table",
        "create_view view:app.z_base",
        "create_view view:app.a_top",
    ]
