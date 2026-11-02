"""Object and column comments, end to end (#464).

Port of ``packages/cli/src/test/comments.e2e.test.ts``: the same cases, through the CLI.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    poll_until,
    quote_ident,
    resolve_live_env,
)

_ON_OBSESSIONDB = os.environ.get("CHKIT_E2E_TARGET") == "obsessiondb"

EDGE_COMMENTS = ['it\'s "q"', "a\\b C:\\new\\t", "trail\\", "l1\nl2", "héllo 世界 🚀", "x AS y"]
EDGE_COUNT = len(EDGE_COMMENTS)


class _Project:
    def __init__(self, root: Path, database: str) -> None:
        self.runner = CliRunner()
        self.root = root
        self.database = database

    def invoke(self, args: list[str]) -> Any:
        return self.runner.invoke(app, args)

    def write_schema(self, definitions: list[str]) -> None:
        (self.root / "schema.py").write_text(
            "from chkit import dictionary, materialized_view, schema, table, view\n\n"
            "definitions = schema(\n    " + ",\n    ".join(definitions) + ",\n)\n",
            encoding="utf-8",
        )

    def migrate(self, name: str) -> None:
        generate = self.invoke(["generate", "--name", f"{self.database}_{name}", "--json"])
        assert generate.exit_code == 0, format_test_diagnostic(f"generate {name}", generate)
        migrate = self.invoke(["migrate", "--apply", "--json"])
        for _ in range(4):
            if migrate.exit_code == 0:
                break
            time.sleep(2)
            migrate = self.invoke(["migrate", "--apply", "--json"])
        assert migrate.exit_code == 0, format_test_diagnostic(f"migrate {name}", migrate)

    def plan(self) -> list[dict[str, Any]]:
        plan = self.invoke(["generate", "--dryrun", "--json"])
        assert plan.exit_code == 0, format_test_diagnostic("generate --dryrun", plan)
        operations: list[dict[str, Any]] = json.loads(plan.stdout)["operations"]
        return operations

    def plan_sql(self) -> list[str]:
        return [op["sql"] for op in self.plan()]

    def pull(self) -> tuple[str, list[str]]:
        pulled = self.invoke(
            ["pull", "--out-file", "pulled.py", "--database", self.database, "--force", "--json"]
        )
        assert pulled.exit_code == 0, format_test_diagnostic("pull", pulled)
        warnings: list[str] = json.loads(pulled.stdout)["warnings"]
        return (self.root / "pulled.py").read_text(encoding="utf-8"), warnings

    def drift(self) -> dict[str, Any]:
        drift = self.invoke(["drift", "--json"])
        assert drift.exit_code == 0, format_test_diagnostic("drift", drift)
        payload: dict[str, Any] = json.loads(drift.stdout)
        return payload

    def assert_no_drift(self) -> None:
        payload = self.drift()
        assert payload["objectDrift"] == []
        assert payload["tableDrift"] == []
        assert payload["drifted"] is False


@pytest.fixture
def project(
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest
) -> Iterator[_Project]:
    env = resolve_live_env()
    label = request.node.name.removeprefix("test_")[:12]
    database = f"{create_prefix(f'cmt_py_{label}')}db"
    journal_table = create_journal_table_name("cmt_py")
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


def _with_comment(comment: str | None) -> dict[str, str]:
    return {} if comment is None else {"comment": comment}


def _table(
    database: str,
    name: str,
    comment: str | None = None,
    columns: list[dict[str, str]] | None = None,
) -> str:
    # index_granularity is spelled out because pull writes the server default (#466).
    spec = {
        "database": database,
        "name": name,
        "engine": "MergeTree()",
        "columns": columns or [{"name": "id", "type": "UInt64"}],
        "primary_key": ["id"],
        "order_by": ["id"],
        "settings": {"index_granularity": 8192},
        **_with_comment(comment),
    }
    return f"table(**{spec!r})"


def _live_comments(ch_client: Any, sql: str) -> dict[str, str]:
    return {str(name): str(comment) for name, comment in ch_client._client.query(sql).result_rows}


def _without_unrelated_ops(operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Pull copies the settings the server adds (#466); they are not about comments.
    return [
        op
        for op in operations
        if op["type"] not in ("alter_table_modify_setting", "alter_table_reset_setting")
    ]


def test_column_comments(project: _Project, ch_client: Any) -> None:
    database = project.database

    def columns(comments: list[str | None]) -> list[dict[str, str]]:
        return [
            {"name": "id", "type": "UInt64", **_with_comment(comments[0])},
            *(
                {"name": f"c{i}", "type": "String", **_with_comment(comments[i + 1])}
                for i in range(EDGE_COUNT)
            ),
        ]

    def write_columns(comments: list[str | None]) -> None:
        project.write_schema([_table(database, "events", columns=columns(comments))])

    def expect_column_comments(comments: list[str | None]) -> None:
        expected = {c["name"]: c.get("comment", "") for c in columns(comments)}
        live = poll_until(
            lambda: _live_comments(
                ch_client,
                "SELECT name, comment FROM system.columns "
                f"WHERE database = '{database}' AND table = 'events' ORDER BY name",
            ),
            lambda value: value == expected,
        )
        assert live == expected

    # CREATE stores every comment exactly, and drift is clean right after.
    created: list[str | None] = [None, *EDGE_COMMENTS]
    write_columns(created)
    project.migrate("init")
    expect_column_comments(created)
    project.assert_no_drift()

    # Add (id), change (c0) and remove (c1) a comment: COMMENT COLUMN and REMOVE COMMENT only.
    changed: list[str | None] = ["added", "changed", None, *EDGE_COMMENTS[2:]]
    write_columns(changed)
    assert project.plan_sql() == [
        f"ALTER TABLE {database}.events COMMENT COLUMN `c0` 'changed';",
        f"ALTER TABLE {database}.events MODIFY COLUMN `c1` REMOVE COMMENT;",
        f"ALTER TABLE {database}.events COMMENT COLUMN `id` 'added';",
    ]
    project.migrate("change")
    expect_column_comments(changed)
    project.assert_no_drift()

    # '' and no comment are the same.
    write_columns(["added", "changed", "", *EDGE_COMMENTS[2:]])
    assert project.plan_sql() == []

    # pull writes each comment exactly, and generating from the pulled schema plans nothing.
    content, _ = project.pull()
    for comment in changed:
        if comment is not None:
            assert f"comment={json.dumps(comment, ensure_ascii=False)}" in content
    (project.root / "schema.py").write_text(content, encoding="utf-8")
    assert _without_unrelated_ops(project.plan()) == []

    # A comment changed on the server is reported by drift.
    write_columns(changed)
    ch_client._client.command(
        f"ALTER TABLE {quote_ident(database)}.events COMMENT COLUMN c2 'server'"
    )
    drift = poll_until(project.drift, lambda payload: len(payload["tableDrift"]) > 0)
    assert [
        (d["table"], d["changedColumns"], d["reasonCodes"]) for d in drift["tableDrift"]
    ] == [(f"{database}.events", ["c2"], ["changed_column"])]


# ObsessionDB applies MODIFY COMMENT on one replica only; the server fix is
# tracked from #407. chkit emits the same SQL on every target, and verify still
# runs these cases.
@pytest.mark.skipif(_ON_OBSESSIONDB, reason="MODIFY COMMENT is replica-local on ObsessionDB (#407)")
def test_object_comments(project: _Project, ch_client: Any) -> None:
    database = project.database

    def objects(comment_at: Callable[[int], str | None], source: str | None = None) -> list[str]:
        out = [_table(database, "src", source), _table(database, "dst")]
        for i in range(EDGE_COUNT):
            comment = _with_comment(comment_at(i))
            out += [
                _table(database, f"t{i}", comment_at(i)),
                "view(**{!r})".format(
                    {"database": database, "name": f"v{i}", "as_": f"SELECT id FROM {database}.src"}
                    | comment
                ),
                "materialized_view(**{!r})".format(
                    {
                        "database": database,
                        "name": f"mv{i}",
                        "to": {"database": database, "name": "dst"},
                        "as_": f"SELECT id FROM {database}.src",
                    }
                    | comment
                ),
                "dictionary(**{!r})".format(
                    {
                        "database": database,
                        "name": f"d{i}",
                        "attributes": [{"name": "id", "type": "UInt64"}],
                        "primary_key": ["id"],
                        "source": "NULL()",
                        "layout": "HASHED()",
                        "lifetime": "MIN 0 MAX 300",
                    }
                    | comment
                ),
            ]
        return out

    def expect_object_comments(
        comment_at: Callable[[int], str | None], source: str | None = None
    ) -> None:
        expected = {"dst": "", "src": source or ""}
        for i in range(EDGE_COUNT):
            for name in (f"t{i}", f"v{i}", f"mv{i}", f"d{i}"):
                expected[name] = comment_at(i) or ""
        live = poll_until(
            lambda: _live_comments(
                ch_client,
                f"SELECT name, comment FROM system.tables WHERE database = '{database}' "
                "ORDER BY name",
            ),
            lambda value: value == expected,
        )
        assert live == expected

    def created(i: int) -> str:
        return EDGE_COMMENTS[i]

    def rotated(i: int) -> str:
        return EDGE_COMMENTS[(i + 1) % EDGE_COUNT]

    # CREATE stores every comment exactly, and drift is clean right after.
    project.write_schema(objects(created))
    project.migrate("init")
    expect_object_comments(created)
    project.assert_no_drift()

    # Add (src) and change (every other object) a comment: MODIFY COMMENT only, no recreate.
    project.write_schema(objects(rotated, "added"))
    change_ops = project.plan()
    assert [op["type"] for op in change_ops] == ["alter_table_modify_comment"] * (
        4 * EDGE_COUNT + 1
    )
    change_sql = [op["sql"] for op in change_ops]
    assert f"ALTER TABLE {database}.src MODIFY COMMENT 'added';" in change_sql
    assert f"ALTER TABLE {database}.v2 MODIFY COMMENT 'l1\nl2';" in change_sql
    project.migrate("change")
    expect_object_comments(rotated, "added")
    project.assert_no_drift()

    # pull writes each comment exactly, keeps `as` when the comment holds AS,
    # and generating from the pulled schema plans nothing.
    content, _ = project.pull()
    for comment in EDGE_COMMENTS:
        assert f"comment={json.dumps(comment, ensure_ascii=False)}" in content
    assert (
        f'name="v4",\n    as_={json.dumps(f"SELECT id FROM {database}.src")},\n'
        '    comment="x AS y",'
    ) in content
    (project.root / "schema.py").write_text(content, encoding="utf-8")
    assert _without_unrelated_ops(project.plan()) == []

    # A comment changed on the server is reported by drift, with both values.
    project.write_schema(objects(rotated, "added"))
    for name in ("t0", "v0", "mv0", "d0"):
        ch_client._client.command(
            f"ALTER TABLE {quote_ident(database)}.{name} MODIFY COMMENT 'server'"
        )
    drift = poll_until(project.drift, lambda payload: len(payload["objectDrift"]) == 4)
    assert drift["objectDrift"] == [
        {
            "code": "comment_mismatch",
            "object": f"{database}.{name}",
            "expected": EDGE_COMMENTS[1],
            "actual": "server",
        }
        for name in ("d0", "mv0", "t0", "v0")
    ]

    # Remove every comment: MODIFY COMMENT '' only; the server comments are empty.
    project.write_schema(objects(lambda _i: None))
    remove_ops = project.plan()
    assert [op["type"] for op in remove_ops] == ["alter_table_modify_comment"] * (
        4 * EDGE_COUNT + 1
    )
    assert all(op["sql"].endswith(" MODIFY COMMENT '';") for op in remove_ops)
    project.migrate("remove")
    expect_object_comments(lambda _i: None)
    project.assert_no_drift()

    # '' and no comment are the same.
    project.write_schema(objects(lambda _i: "", ""))
    assert project.plan_sql() == []


def test_pull_skips_an_inner_storage_view(project: _Project, ch_client: Any) -> None:
    database = project.database
    client = ch_client._client
    client.command(f"CREATE DATABASE IF NOT EXISTS {quote_ident(database)}")
    client.command(
        f"CREATE TABLE {quote_ident(database)}.src (id UInt64) ENGINE = MergeTree ORDER BY id"
    )
    client.command(
        f"CREATE MATERIALIZED VIEW {quote_ident(database)}.inner_mv ENGINE = MergeTree "
        f"ORDER BY id COMMENT 'maps src TO nothing' AS SELECT id FROM {quote_ident(database)}.src"
    )
    content, warnings = project.pull()
    assert warnings == [
        f'Materialized view "{database}.inner_mv" stores its rows in an inner table (it has '
        "no TO table), which the schema DSL does not support. Pull skipped the view and its "
        "inner table."
    ]
    assert 'name="src"' in content
    assert ".inner" not in content
    assert "inner_mv" not in content
