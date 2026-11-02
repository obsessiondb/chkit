"""``generate --dryrun`` prints what TS ``emitGeneratePlanOutput`` prints (#461)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app

CONFIG = (
    'from chkit import define_config\n\nconfig = define_config({"schema": "./schema.py", '
    '"outDir": "./chkit"})\n'
)


def write_schema(project: Path, column: str) -> None:
    (project / "schema.py").write_text(
        "from chkit import table\n\n"
        "events = table(database='app', name='events', engine='MergeTree()', "
        f"columns=[{{'name': 'id', 'type': 'UInt64'}}, {{'name': '{column}', 'type': 'String'}}], "
        "primary_key=['id'], order_by=['id'])\n"
    )


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG)
    write_schema(tmp_path, "old_name")
    assert CliRunner().invoke(app, ["generate", "--name", "init"]).exit_code == 0
    write_schema(tmp_path, "new_name")
    return tmp_path


def test_dryrun_text_lists_the_plan_then_the_rename_suggestions(project: Path) -> None:
    result = CliRunner().invoke(app, ["generate", "--dryrun"])
    assert result.exit_code == 0, result.output
    assert result.stdout == (
        "Planned operations: 2\n"
        "Risk summary: safe=1, caution=0, danger=1\n"
        "- alter_table_add_column [safe] table:app.events:column:new_name\n"
        "- alter_table_drop_column [danger] table:app.events:column:old_name\n"
        "\n"
        "Rename suggestions (review and confirm manually):\n"
        "- column app.events: old_name -> new_name [high]\n"
        "  Dropped and added columns have an identical non-name definition "
        "(type, nullability, default, comment).\n"
        "  Confirm with: ALTER TABLE app.events RENAME COLUMN IF EXISTS `old_name` TO `new_name`;\n"
    )


def test_dryrun_json_puts_scope_first_and_omits_unset_warnings(project: Path) -> None:
    result = CliRunner().invoke(app, ["generate", "--dryrun", "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert list(payload) == [
        "command",
        "schemaVersion",
        "scope",
        "mode",
        "operationCount",
        "riskSummary",
        "operations",
        "renameSuggestions",
        "warnings",
    ]
    assert [list(op) for op in payload["operations"]] == [["type", "key", "risk", "sql"]] * 2


def test_dryrun_json_unmatched_selector_warning(project: Path) -> None:
    result = CliRunner().invoke(app, ["generate", "--dryrun", "--json", "--table", "nope"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["warning"] == 'No tables matched selector "nope".'
    text = CliRunner().invoke(app, ["generate", "--dryrun", "--table", "nope"])
    assert text.stdout == 'No tables matched selector "nope". No changes planned.\n'
