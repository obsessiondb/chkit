"""Rejected ALIAS/EPHEMERAL storage-kind changes surface as validation issues (#206)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app

SCHEMA = """
from chkit import schema, table

events = table(
    database="app", name="events", engine="MergeTree",
    columns=[
        {{"name": "id", "type": "UInt64"}},
        {{"name": "ts", "type": "DateTime"}},
        {{"name": "day", "type": "Date", "default_kind": "{kind}", "default": "fn:toDate(ts)"}},
    ],
    primary_key=["id"], order_by=["id"],
)
users = table(
    database="app", name="users", engine="MergeTree",
    columns=[{{"name": "id", "type": "UInt64"}}{users_extra}],
    primary_key=["id"], order_by=["id"],
)

definitions = schema(events, users)
"""
ISSUE = {
    "code": "column_kind_change_unsupported",
    "kind": "table",
    "database": "app",
    "name": "events",
    "message": "Cannot automatically change column app.events.day from DEFAULT to ALIAS; "
    "storage-kind conversions involving ALIAS or EPHEMERAL are not supported. "
    "Keep the column declared as DEFAULT in the schema.",
}


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Snapshot ``day`` as DEFAULT, then declare it ALIAS and add ``users.email``."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(
        'from chkit import define_config\n\nconfig = define_config({"schema": "./schema.py", '
        '"outDir": "./chkit", "migrationsDir": "./chkit/migrations", "metaDir": "./chkit/meta"})\n'
    )
    (tmp_path / "schema.py").write_text(SCHEMA.format(kind="DEFAULT", users_extra=""))
    result = CliRunner().invoke(app, ["generate", "--name", "init"])
    assert result.exit_code == 0, result.output
    (tmp_path / "schema.py").write_text(
        SCHEMA.format(kind="ALIAS", users_extra=', {"name": "email", "type": "String"}')
    )
    return tmp_path


@pytest.mark.usefixtures("project")
def test_generate_reports_the_issue_without_a_traceback() -> None:
    result = CliRunner().invoke(app, ["generate", "--dryrun", "--json"])
    assert result.exit_code == 1
    assert json.loads(result.stdout) == {"error": "validation_failed", "issues": [ISSUE]}
    result = CliRunner().invoke(app, ["generate", "--dryrun"])
    assert result.exit_code == 1
    assert result.stderr == (
        f"Schema validation failed with 1 issue\n- [{ISSUE['code']}] {ISSUE['message']}\n"
    )


@pytest.mark.usefixtures("project")
@pytest.mark.parametrize(
    ("selector", "issues", "operations"), [(None, 1, 1), ("events", 1, 0), ("users", 0, 1)]
)
def test_drift_reports_the_issue_and_keeps_other_scoped_changes(
    selector: str | None, issues: int, operations: int
) -> None:
    result = CliRunner().invoke(app, ["drift", "--json", *(["--table", selector] if selector else [])])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert [issue["code"] for issue in payload.get("issues", [])] == [ISSUE["code"]] * issues
    assert [op["key"] for op in payload["operations"]] == ["table:app.users:column:email"] * operations
