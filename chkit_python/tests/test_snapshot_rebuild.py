"""Port of ``packages/cli/src/test/snapshot-rebuild.test.ts`` (CLI contract of
``chkit snapshot rebuild`` and of commands reading a conflicted snapshot).

Hermetic: no ClickHouse connection. Cases that exercise Bun/jiti module
caching and the TS user-profile config have no chkit-py counterpart.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner, Result

from chkit.cli.main import app

USERS = """users = table(
    database="app",
    name="users",
    columns=[
        {"name": "id", "type": "UInt64"},
        {"name": "email", "type": "String"},
    ],
    engine="MergeTree()",
    primary_key=["id"],
    order_by=["id"],
)"""

USERS_WITH_CREATED_AT = """users = table(
    database="app",
    name="users",
    columns=[
        {"name": "id", "type": "UInt64"},
        {"name": "email", "type": "String"},
        {"name": "created_at", "type": "DateTime"},
    ],
    engine="MergeTree()",
    primary_key=["id"],
    order_by=["id"],
)"""

EVENTS = """events = table(
    database="app",
    name="events",
    columns=[
        {"name": "id", "type": "UInt64"},
        {"name": "source", "type": "String"},
    ],
    engine="MergeTree()",
    primary_key=["id"],
    order_by=["id"],
)"""

USERS_VIEW = 'users_view = view(database="app", name="users_view", as_="SELECT id FROM app.users")'

# Column kinds and expression defaults in key orders and spellings that canonicalization rewrites.
LOGS = """logs = table(
    database="app",
    name="logs",
    columns=[
        {"name": "id", "type": "UInt64"},
        {"name": "ts", "type": "DateTime64(3)", "default": {"expression": "now64(3)"}, "comment": " insert time "},
        {"name": "raw", "type": "String", "default_kind": "EPHEMERAL"},
        {"default_kind": "MATERIALIZED", "name": "day", "type": "Date", "default": {"expression": "toDate(ts)"}},
        {"name": "label", "type": "String", "default_kind": "ALIAS", "default": "fn:toString(day)"},
        {"name": "size", "type": "UInt64", "default_kind": "DEFAULT", "default": {"expression": "length(raw)"}},
    ],
    engine="MergeTree()",
    primary_key=["id"],
    order_by=["id"],
)"""

BROKEN = """broken = table(
    database="app",
    name="broken",
    columns=[{"name": "id", "type": "UInt64"}],
    engine="MergeTree()",
    primary_key=["missing_col"],
    order_by=["id"],
)"""

# A plain string MATERIALIZED default and an ALIAS sort key, which validation rejects.
UNSTORED = """unstored = table(
    database="app",
    name="unstored",
    columns=[
        {"name": "id", "type": "UInt64"},
        {"name": "ts", "type": "DateTime"},
        {"name": "day", "type": "Date", "default_kind": "MATERIALIZED", "default": "toDate(ts)"},
        {"name": "bucket", "type": "UInt64", "default_kind": "ALIAS", "default": {"expression": "id % 16"}},
    ],
    engine="MergeTree()",
    primary_key=["id"],
    order_by=["id", "bucket"],
)"""


def schema_source(declarations: list[str], exported: list[str]) -> str:
    body = "\n\n".join(declarations)
    return (
        f"from chkit import schema, table, view\n\n{body}\n\n"
        f"definitions = schema({', '.join(exported)})\n"
    )


INITIAL_SCHEMA = schema_source([USERS, EVENTS], ["users", "events"])
EDITED_SCHEMA = schema_source([USERS_WITH_CREATED_AT, USERS_VIEW], ["users", "users_view"])
CONFLICTED_SCHEMA = schema_source(
    [f"<<<<<<< HEAD\n{USERS}\n=======\n{USERS_WITH_CREATED_AT}\n>>>>>>> feature", EVENTS],
    ["users", "events"],
)

CONFLICT_HINT = (
    "\nThe file contains unresolved merge conflict markers. "
    "Resolve the conflict and run the command again."
)


@dataclass(frozen=True)
class Project:
    dir: Path
    config_path: Path
    schema_path: Path
    meta_dir: Path

    @property
    def snapshot_path(self) -> Path:
        return self.meta_dir / "snapshot.json"


def create_project(root: Path, schema: str, *, config_body: str | None = None) -> Project:
    """A project whose config uses project-relative paths, like a real config."""
    (root / "schema.py").write_text(schema, encoding="utf-8")
    config_path = root / "clickhouse.config.py"
    config_path.write_text(
        config_body
        or (
            "from chkit import define_config\n\n"
            'config = define_config({"schema": "./schema.py", "outDir": "./chkit", '
            '"migrationsDir": "./chkit/migrations", "metaDir": "./chkit/meta"})\n'
        ),
        encoding="utf-8",
    )
    return Project(
        dir=root,
        config_path=config_path,
        schema_path=root / "schema.py",
        meta_dir=root / "chkit" / "meta",
    )


@pytest.fixture
def project_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    return tmp_path.resolve()


def chkit(project: Project, args: list[str]) -> Result:
    return CliRunner().invoke(app, [*args, "--config", str(project.config_path)])


def without_generated_at(text: str) -> str:
    return re.sub(r'"generatedAt": "[^"]*"', '"generatedAt": "<generatedAt>"', text, count=1)


def conflict_on_generated_at(text: str) -> str:
    lines: list[str] = []
    for line in text.split("\n"):
        if '"generatedAt"' in line:
            lines.extend(
                [
                    "<<<<<<< HEAD",
                    line,
                    "=======",
                    '  "generatedAt": "2026-01-01T00:00:00.000Z",',
                    ">>>>>>> feature",
                ]
            )
        else:
            lines.append(line)
    return "\n".join(lines)


def operation_count(project: Project) -> int:
    plan = chkit(project, ["generate", "--dryrun", "--json"])
    assert plan.exit_code == 0, plan.output
    count = json.loads(plan.stdout)["operationCount"]
    assert isinstance(count, int)
    return count


def payload_of(result: Result) -> dict[str, Any]:
    payload = json.loads(result.stdout)
    assert isinstance(payload, dict)
    return payload


# ---------- chkit snapshot rebuild ----------


def test_writes_the_snapshot_generate_writes_apart_from_generated_at(project_dir: Path) -> None:
    project = create_project(
        project_dir,
        schema_source([USERS, EVENTS, USERS_VIEW, LOGS], ["users", "events", "users_view", "logs"]),
    )
    assert chkit(project, ["generate", "--name", "init", "--json"]).exit_code == 0
    generated = project.snapshot_path.read_text(encoding="utf-8")
    # The fixture exercises column kinds and the canonical `fn:` form of expression defaults.
    assert '"defaultKind": "MATERIALIZED"' in generated
    assert '"default": "fn:now64(3)"' in generated
    project.snapshot_path.unlink()

    result = chkit(project, ["snapshot", "rebuild", "--json"])

    assert result.exit_code == 0, result.output
    assert payload_of(result) == {
        "command": "snapshot",
        "schemaVersion": 1,
        "subcommand": "rebuild",
        "mode": "write",
        "snapshotFile": str(project.snapshot_path),
        "written": True,
        "definitionCount": 4,
        "previous": {"status": "missing"},
    }
    rebuilt = project.snapshot_path.read_text(encoding="utf-8")
    assert without_generated_at(rebuilt) == without_generated_at(generated)
    assert operation_count(project) == 0


def test_uses_stable_json_payload_keys(project_dir: Path) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)

    result = chkit(project, ["snapshot", "rebuild", "--dryrun", "--json"])

    assert result.exit_code == 0, result.output
    assert sorted(payload_of(result)) == [
        "command",
        "definitionCount",
        "mode",
        "previous",
        "schemaVersion",
        "snapshotFile",
        "subcommand",
        "written",
    ]


def test_reports_added_removed_and_changed_entries_and_absorbs_them(project_dir: Path) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)
    assert chkit(project, ["generate", "--name", "init", "--json"]).exit_code == 0
    project.schema_path.write_text(EDITED_SCHEMA, encoding="utf-8")

    result = chkit(project, ["snapshot", "rebuild", "--json"])

    assert result.exit_code == 0, result.output
    payload = payload_of(result)
    assert payload["previous"] == {
        "status": "parsed",
        "added": ["view:app.users_view"],
        "removed": ["table:app.events"],
        "changed": ["table:app.users"],
    }
    assert payload["written"] is True
    assert payload["definitionCount"] == 2
    # By construction: the rebuilt snapshot already holds the edited definitions.
    assert operation_count(project) == 0


def test_dryrun_prints_the_report_and_the_caution_without_writing(project_dir: Path) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)
    assert chkit(project, ["generate", "--name", "init", "--json"]).exit_code == 0
    before = project.snapshot_path.read_text(encoding="utf-8")
    project.schema_path.write_text(EDITED_SCHEMA, encoding="utf-8")

    result = chkit(project, ["snapshot", "rebuild", "--dryrun"])

    assert result.exit_code == 0, result.output
    out = result.stdout
    assert f"Dry run: {project.snapshot_path} was not written." in out
    assert "Definitions:        2" in out
    assert "Previous snapshot:  1 added, 1 removed, 1 changed" in out
    assert "  + view:app.users_view" in out
    assert "  - table:app.events" in out
    assert "  ~ table:app.users" in out
    assert "Caution: the rebuilt snapshot would record every schema definition" in out
    assert "`chkit generate --dryrun`" in out
    assert "https://chkit.obsessiondb.com/cli/snapshot/#when-not-to-rebuild" in out
    assert project.snapshot_path.read_text(encoding="utf-8") == before


def test_dryrun_without_a_snapshot_creates_nothing(project_dir: Path) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)

    result = chkit(project, ["snapshot", "rebuild", "--dryrun", "--json"])

    assert result.exit_code == 0, result.output
    payload = payload_of(result)
    assert payload["mode"] == "plan"
    assert payload["written"] is False
    assert payload["previous"] == {"status": "missing"}
    assert not project.snapshot_path.exists()


def test_leaves_an_up_to_date_snapshot_untouched(project_dir: Path) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)
    assert chkit(project, ["generate", "--name", "init", "--json"]).exit_code == 0
    generated = project.snapshot_path.read_text(encoding="utf-8")

    as_json = chkit(project, ["snapshot", "rebuild", "--json"])
    as_text = chkit(project, ["snapshot", "rebuild"])

    assert as_json.exit_code == 0, as_json.output
    payload = payload_of(as_json)
    assert payload["written"] is False
    assert payload["previous"] == {"status": "parsed", "added": [], "removed": [], "changed": []}
    assert as_text.exit_code == 0
    assert f"Snapshot is up to date: {project.snapshot_path}" in as_text.stdout
    assert "Caution" not in as_text.stdout
    assert project.snapshot_path.read_text(encoding="utf-8") == generated


def test_rebuilds_a_conflicted_snapshot_and_prints_the_review_commands(project_dir: Path) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)
    assert chkit(project, ["generate", "--name", "init", "--json"]).exit_code == 0
    conflicted = conflict_on_generated_at(project.snapshot_path.read_text(encoding="utf-8"))
    project.snapshot_path.write_text(conflicted, encoding="utf-8")

    dryrun = chkit(project, ["snapshot", "rebuild", "--dryrun", "--json"])

    assert dryrun.exit_code == 0, dryrun.output
    assert payload_of(dryrun)["previous"] == {"status": "conflicted"}
    assert project.snapshot_path.read_text(encoding="utf-8") == conflicted

    result = chkit(project, ["snapshot", "rebuild"])

    assert result.exit_code == 0, result.output
    assert re.search(r"^Rebuilt snapshot: /.*/chkit/meta/snapshot\.json$", result.stdout, re.M)
    assert (
        "Previous snapshot:  unresolved merge conflict markers (not compared)" in result.stdout
    )
    assert (
        "\n".join(
            [
                "  git diff HEAD -- chkit/meta/snapshot.json",
                "  git diff MERGE_HEAD -- chkit/meta/snapshot.json    # during a merge",
                "  git diff REBASE_HEAD -- chkit/meta/snapshot.json   # during a rebase",
            ]
        )
        in result.stdout
    )
    assert "Caution: the rebuilt snapshot records every schema definition" in result.stdout
    rebuilt = project.snapshot_path.read_text(encoding="utf-8")
    assert "<<<<<<<" not in rebuilt
    assert json.loads(rebuilt)["version"] == 1
    assert operation_count(project) == 0


@pytest.mark.parametrize(
    ("raw", "reason"),
    [("", "empty"), ('{ "version": 1,', "invalid_json"), ('{"definitions":{}}', "invalid_shape")],
)
def test_reports_unreadable_snapshots_without_comparing_them(
    project_dir: Path, raw: str, reason: str
) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)
    project.meta_dir.mkdir(parents=True)
    project.snapshot_path.write_text(raw, encoding="utf-8")

    result = chkit(project, ["snapshot", "rebuild", "--dryrun", "--json"])

    assert result.exit_code == 0, result.output
    assert payload_of(result)["previous"] == {"status": "unreadable", "reason": reason}


def test_text_output_for_an_unreadable_snapshot_prints_the_restore_command(
    project_dir: Path,
) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)
    project.meta_dir.mkdir(parents=True)
    project.snapshot_path.write_text('{ "version": 1,', encoding="utf-8")

    result = chkit(project, ["snapshot", "rebuild"])

    assert result.exit_code == 0, result.output
    assert "Previous snapshot:  invalid JSON (not compared)" in result.stdout
    assert (
        "If no merge or rebase is in progress and the damaged file is committed" in result.stdout
    )
    assert "  git checkout HEAD -- chkit/meta/snapshot.json\n" in result.stdout
    assert json.loads(project.snapshot_path.read_text(encoding="utf-8"))["version"] == 1


@pytest.mark.parametrize(
    "args",
    [
        ["snapshot", "rebuild"],
        ["generate", "--dryrun"],
        ["generate", "--dryrun", "--table", "app.users"],
    ],
)
def test_fails_and_names_a_schema_file_that_still_has_conflict_markers(
    project_dir: Path, args: list[str]
) -> None:
    project = create_project(project_dir, CONFLICTED_SCHEMA)
    failure = f"Failed to load schema file {project.schema_path}: "

    result = chkit(project, args)

    assert result.exit_code == 1
    # snapshot reports on stderr; generate lets the error propagate (chkit-py convention).
    message = result.stderr if args[0] == "snapshot" else str(result.exception)
    assert failure in message
    assert CONFLICT_HINT in message
    assert not project.snapshot_path.exists()


def test_conflicted_schema_file_under_json_emits_an_error_envelope(project_dir: Path) -> None:
    project = create_project(project_dir, CONFLICTED_SCHEMA)

    result = chkit(project, ["snapshot", "rebuild", "--json"])

    assert result.exit_code == 1
    envelope = payload_of(result)
    assert envelope["ok"] is False
    assert envelope["command"] == "snapshot"
    assert envelope["error"]["message"].startswith(
        f"Failed to load schema file {project.schema_path}: "
    )
    assert envelope["error"]["message"].endswith(CONFLICT_HINT)
    assert not project.snapshot_path.exists()


def test_validates_definitions_like_generate_json(project_dir: Path) -> None:
    project = create_project(project_dir, schema_source([BROKEN], ["broken"]))

    result = chkit(project, ["snapshot", "rebuild", "--json"])

    assert result.exit_code == 1
    payload = payload_of(result)
    assert payload["command"] == "snapshot"
    assert payload["error"] == "validation_failed"
    assert any(issue["code"] == "primary_key_missing_column" for issue in payload["issues"])
    assert sorted(payload) == ["command", "error", "issues", "schemaVersion"]
    assert not project.snapshot_path.exists()


def test_validates_definitions_like_generate_text(project_dir: Path) -> None:
    project = create_project(project_dir, schema_source([BROKEN], ["broken"]))

    result = chkit(project, ["snapshot", "rebuild"])

    assert result.exit_code == 1
    assert "Schema validation failed with 1 issue" in result.stderr
    assert "[primary_key_missing_column]" in result.stderr
    assert not project.snapshot_path.exists()


def test_reports_the_same_column_default_and_kind_issues_as_generate(project_dir: Path) -> None:
    project = create_project(project_dir, schema_source([UNSTORED], ["unstored"]))

    rebuild = chkit(project, ["snapshot", "rebuild", "--json"])
    generate = chkit(project, ["generate", "--json"])

    assert rebuild.exit_code == 1
    assert generate.exit_code == 1
    rebuild_issues = payload_of(rebuild)["issues"]
    assert [issue["code"] for issue in rebuild_issues] == [
        "column_expression_requires_fn",
        "column_kind_not_stored",
    ]
    assert rebuild_issues == payload_of(generate)["issues"]
    assert not project.snapshot_path.exists()


def test_runs_config_functions_and_plugin_hooks_with_command_snapshot(project_dir: Path) -> None:
    log_path = project_dir / "hooks.log"
    (project_dir / "hook_probe_plugin.py").write_text(
        f"""from chkit.plugins import ChxPlugin, ChxPluginManifest


class Hooks:
    def on_config_loaded(self, ctx):
        with open({str(log_path)!r}, "a") as log:
            log.write(f"onConfigLoaded:{{ctx.command}}\\n")

    def on_schema_loaded(self, ctx):
        with open({str(log_path)!r}, "a") as log:
            log.write(f"onSchemaLoaded:{{ctx.command}}\\n")
        rewritten = []
        for definition in ctx.definitions:
            update = {{"comment": "  rewritten by plugin  "}}
            if definition.kind == "view":
                update["as_"] = "SELECT   id\\n  FROM app.users"
            rewritten.append(definition.model_copy(update=update))
        return rewritten


plugin = ChxPlugin(manifest=ChxPluginManifest(name="hook-probe", api_version=1), hooks=Hooks())
""",
        encoding="utf-8",
    )
    config_body = f"""import sys
sys.path.insert(0, {str(project_dir)!r})
from hook_probe_plugin import plugin


def config(env):
    with open({str(log_path)!r}, "a") as log:
        log.write(f"config:{{env.command}}\\n")
    return {{
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "plugins": [plugin],
    }}
"""
    project = create_project(
        project_dir,
        schema_source([USERS, USERS_VIEW], ["users", "users_view"]),
        config_body=config_body,
    )
    try:
        assert chkit(project, ["generate", "--name", "init", "--json"]).exit_code == 0
        generated = project.snapshot_path.read_text(encoding="utf-8")
        result = chkit(project, ["snapshot", "rebuild", "--json"])
    finally:
        sys.path.remove(str(project_dir))
        sys.modules.pop("hook_probe_plugin", None)

    assert result.exit_code == 0, result.output
    # Without the hook (or without canonicalizing its output) both entries would read as changed.
    payload = payload_of(result)
    assert payload["previous"] == {"status": "parsed", "added": [], "removed": [], "changed": []}
    assert payload["written"] is False
    assert '"comment": "rewritten by plugin"' in generated
    assert log_path.read_text(encoding="utf-8").strip().split("\n") == [
        "config:generate",
        "onConfigLoaded:generate",
        "onSchemaLoaded:generate",
        "config:snapshot",
        "onConfigLoaded:snapshot",
        "onSchemaLoaded:snapshot",
    ]


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["snapshot"], "Missing snapshot subcommand. Available: rebuild."),
        (["snapshot", "bogus"], 'Unknown snapshot subcommand "bogus". Available: rebuild.'),
        (
            ["snapshot", "rebuild", "extra"],
            'Unexpected argument "extra" for `chkit snapshot rebuild`.',
        ),
        (["snapshot", "rebuild", "--table", "app.users"], "does not support --table"),
    ],
)
def test_rejects_a_missing_or_unknown_subcommand_extra_arguments_and_table(
    project_dir: Path, args: list[str], message: str
) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)

    result = chkit(project, args)

    assert result.exit_code == 1
    assert message in result.stderr
    assert not project.snapshot_path.exists()


def test_usage_errors_print_the_usage(project_dir: Path) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)

    result = chkit(project, ["snapshot", "bogus"])

    assert "Usage: chkit snapshot rebuild [--dryrun] [--json]" in result.stderr


def test_emits_a_json_error_envelope_for_usage_errors(project_dir: Path) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)

    result = chkit(project, ["snapshot", "--json"])

    assert result.exit_code == 1
    envelope = payload_of(result)
    assert envelope["ok"] is False
    assert envelope["command"] == "snapshot"
    assert envelope["error"]["code"] == "error"
    assert "Missing snapshot subcommand" in envelope["error"]["message"]


def test_help_shows_the_rebuild_usage(project_dir: Path) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)

    command_help = chkit(project, ["snapshot", "--help"])
    global_help = CliRunner().invoke(app, ["--help"])

    assert command_help.exit_code == 0
    assert "chkit snapshot rebuild [--dryrun]" in command_help.stdout
    assert "--dryrun" in command_help.stdout
    assert global_help.exit_code == 0
    assert re.search(r"snapshot\s+.*Rebuild snapshot\.json", global_help.stdout)


# ---------- commands reading a conflicted snapshot ----------


def test_generate_and_drift_name_the_conflict_markers_and_point_to_rebuild(
    project_dir: Path,
) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)
    assert chkit(project, ["generate", "--name", "init", "--json"]).exit_code == 0
    project.snapshot_path.write_text(
        conflict_on_generated_at(project.snapshot_path.read_text(encoding="utf-8")),
        encoding="utf-8",
    )

    result = chkit(project, ["generate", "--dryrun"])

    assert result.exit_code == 1
    message = str(result.exception)
    # chkit-py commands keep config.meta_dir as given (relative here), so the path is too.
    assert message.startswith(
        "Snapshot chkit/meta/snapshot.json contains unresolved merge conflict markers."
    )
    assert "run `chkit snapshot rebuild`" in message
    assert "https://chkit.obsessiondb.com/cli/snapshot/" in message


def test_invalid_json_suggests_restoring_or_rebuilding_not_removing(project_dir: Path) -> None:
    project = create_project(project_dir, INITIAL_SCHEMA)
    project.meta_dir.mkdir(parents=True)
    project.snapshot_path.write_text('{ "version": 1,', encoding="utf-8")

    result = chkit(project, ["generate", "--dryrun"])

    assert result.exit_code == 1
    message = str(result.exception)
    assert "Invalid snapshot JSON at " in message
    assert "Outside a merge or rebase, restore the committed version from git." in message
    assert "chkit snapshot rebuild" in message
    assert "remove the file" not in message
