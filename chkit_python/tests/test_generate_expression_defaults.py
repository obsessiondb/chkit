"""Port of the #234 cases in ``packages/cli/src/test/generate.e2e.test.ts``."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.commands.init import _EXAMPLE_TEMPLATE
from chkit.cli.main import app

CONFIG = (
    'from chkit import define_config\n\nconfig = define_config({"schema": "./schema.py", '
    '"outDir": "./chkit", "migrationsDir": "./chkit/migrations", "metaDir": "./chkit/meta"})\n'
)


def render_default_schema(default_source: str) -> str:
    return (
        "from chkit import SQLExpression, schema, table\n\n"
        "events = table(\n    database='app',\n    name='events',\n    columns=[\n"
        "        {'name': 'id', 'type': 'UInt64'},\n"
        f"        {{'name': 'updated_at', 'type': \"DateTime64(3, 'UTC')\", 'default': {default_source}}},\n"
        "    ],\n    engine='MergeTree()',\n    primary_key=['id'],\n    order_by=['id'],\n)\n\n"
        "definitions = schema(events)\n"
    )


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    return tmp_path


def test_rejects_a_function_call_written_as_a_plain_string_default_and_writes_nothing(
    project: Path,
) -> None:
    (project / "schema.py").write_text(render_default_schema("'now64(3)'"))
    result = CliRunner().invoke(app, ["generate", "--json"])
    assert result.exit_code == 1
    payload = json.loads(result.stdout)
    assert payload["error"] == "validation_failed"
    assert [issue["code"] for issue in payload["issues"]] == ["column_default_looks_like_expression"]
    message = payload["issues"][0]["message"]
    assert 'Use default: { expression: "now64(3)" } to render DEFAULT now64(3).' in message
    # Keeping the quoted text is only for a type chkit misjudged: ClickHouse rejects it here.
    assert (
        "If chkit misjudged the type and the column should store this text, use "
        "default: { expression: \"'now64(3)'\" }." in message
    )
    assert not (project / "chkit" / "migrations").exists()
    assert not (project / "chkit" / "meta" / "snapshot.json").exists()

    text = CliRunner().invoke(app, ["generate"])
    assert text.exit_code == 1
    assert "[column_default_looks_like_expression]" in text.stderr


@pytest.mark.parametrize(
    "initial", ["SQLExpression(expression='now64(3)')", "{'expression': 'now64(3)'}"]
)
def test_switching_a_default_between_sql_expression_and_fn_generates_nothing(
    project: Path, initial: str
) -> None:
    (project / "schema.py").write_text(render_default_schema(initial))
    first = CliRunner().invoke(app, ["generate", "--name", "init", "--json"])
    assert first.exit_code == 0, first.output
    migration_file = json.loads(first.stdout)["migrationFile"]
    assert migration_file
    assert "`updated_at` DateTime64(3, 'UTC') DEFAULT now64(3)" in Path(migration_file).read_text()
    snapshot_path = project / "chkit" / "meta" / "snapshot.json"
    before = json.loads(snapshot_path.read_text())
    updated_at = next(c for c in before["definitions"][0]["columns"] if c["name"] == "updated_at")
    assert updated_at["default"] == "fn:now64(3)"

    (project / "schema.py").write_text(render_default_schema("'fn: now64(3)'"))
    second = CliRunner().invoke(app, ["generate", "--json"])
    assert second.exit_code == 0, second.output
    payload = json.loads(second.stdout)
    assert payload["operationCount"] == 0
    # A no-op plan writes no migration file: `migrationFile: null`, like TS.
    assert "migrationFile" in payload
    assert payload["migrationFile"] is None
    assert json.loads(snapshot_path.read_text())["definitions"] == before["definitions"]


def test_plans_the_init_example_schema_with_an_expression_default(project: Path) -> None:
    assert "\"default\": {\"expression\": \"now64(3)\"}" in _EXAMPLE_TEMPLATE
    (project / "schema.py").write_text(_EXAMPLE_TEMPLATE)
    result = CliRunner().invoke(app, ["generate", "--dryrun", "--json"])
    assert result.exit_code == 0, result.output
    operations = json.loads(result.stdout)["operations"]
    create_table = next(op for op in operations if op["type"] == "create_table")
    assert "`ingested_at` DateTime64(3) DEFAULT now64(3)" in create_table["sql"]
