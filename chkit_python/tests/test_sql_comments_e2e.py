"""Port of ``packages/cli/src/test/sql-comments.e2e.test.ts`` (#232).

Every comment form ClickHouse knows, in the places #232 broke: the issue's
``--`` comment with an apostrophe between CTEs, ``#``, ``//`` (with an
apostrophe too), a nested block comment, and a trailing comment that used to
swallow the statement's ``;``; a commented TTL and partition; a commented
materialized view; a block comment in an expression default, which drift must
ignore. The visits table names its key columns with comment markers
(``user--id``, ``# visits``, ``a//b``), which drift must read as names.
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

ISSUE_NOTE = "The attendee's company: through their person record, else through the email domain."
MARKER = "keep -- this # and // literal"


def _render_schema(n: dict[str, str], note: str) -> str:
    db = n["database"]
    meeting_sql = "\n".join([
        "WITH people_by_email AS (SELECT person_id, company_id, arrayJoin(emails) AS email "
        f"FROM {db}.{n['people']}),",
        f"-- {note}",
        "meeting_company AS (",
        "  SELECT email, company_id FROM people_by_email # hash comment",
        "  // the person's own company wins",
        ")",
        f"SELECT /* block /* nested */ comment */ email, company_id, '{MARKER}' AS marker",
        "FROM meeting_company",
        "-- trailing comment",
    ])
    counts_sql = "\n".join([
        "SELECT company_id, count() AS n -- one row per person",
        f"FROM {db}.{n['people']}",
        "GROUP BY company_id -- trailing",
    ])
    people_columns = [
        {"name": "person_id", "type": "UInt64"},
        {"name": "company_id", "type": "UInt64"},
        {"name": "emails", "type": "Array(String)"},
        {"name": "ts", "type": "DateTime", "default": "fn:now() /* server time */"},
    ]
    visits_columns = [
        {"name": "user--id", "type": "UInt64"},
        {"name": "# visits", "type": "UInt64"},
        {"name": "a//b", "type": "UInt64"},
    ]
    return "\n".join([
        "from chkit import materialized_view, schema, table, view",
        "",
        "definitions = schema(",
        f"    table(database={db!r}, name={n['people']!r}, columns={people_columns!r}, "
        "engine='MergeTree()', primary_key=['person_id'], order_by=['person_id'], "
        f"partition_by={'toYYYYMM(ts) -- monthly partitions'!r}, "
        f"ttl={'ts + toIntervalDay(3650) -- keep ten years'!r}),",
        f"    table(database={db!r}, name={n['counts']!r}, columns=[{{'name': 'company_id', "
        "'type': 'UInt64'}, {'name': 'n', 'type': 'UInt64'}], engine='MergeTree()', "
        "primary_key=['company_id'], order_by=['company_id']),",
        f"    table(database={db!r}, name={n['visits']!r}, columns={visits_columns!r}, "
        "engine='MergeTree()', primary_key=['user--id'], order_by=['user--id', '# visits', 'a//b']),",
        f"    view(database={db!r}, name={n['meeting_view']!r}, as_={meeting_sql!r}),",
        f"    view(database={db!r}, name={n['follow_up_view']!r}, as_='SELECT 1 AS x'),",
        f"    materialized_view(database={db!r}, name={n['counts_mv']!r}, "
        f"to={{'database': {db!r}, 'name': {n['counts']!r}}}, as_={counts_sql!r}),",
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


def _invoke_with_retry(runner: CliRunner, args: list[str], attempts: int = 3) -> Any:
    result = runner.invoke(app, args)
    for _ in range(attempts - 1):
        if result.exit_code == 0:
            break
        time.sleep(2)
        result = runner.invoke(app, args)
    return result


def test_objects_whose_sql_carries_comments_migrate_and_comment_edits_plan_nothing(
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = ch_client._client
    env = resolve_live_env()
    database = client.database
    journal_table = create_journal_table_name("sqlcomments_py")
    prefix = create_prefix("sqlcomments")
    names = {
        "database": database,
        "people": f"{prefix}person_identity",
        "counts": f"{prefix}company_counts",
        "counts_mv": f"{prefix}company_counts_mv",
        "meeting_view": f"{prefix}a_meeting_company",
        "follow_up_view": f"{prefix}b_follow_up",
        "visits": f"{prefix}visits",
    }
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")
    runner = CliRunner()

    def obj(name: str) -> str:
        return f"{quote_ident(database)}.{quote_ident(name)}"

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
    schema_path = tmp_path / "schema.py"
    schema_path.write_text(_render_schema(names, ISSUE_NOTE))
    try:
        # 1. Every operation stays its own statement, and no comment text
        #    reaches the migration; the literal that looks like comments does.
        generated = runner.invoke(app, [
            "generate", "--name", "sql_comments", "--migration-id", "20990101000000", "--json"])
        assert generated.exit_code == 0, format_test_diagnostic("generate failed", generated)
        payload = json.loads(generated.stdout)
        sql = Path(payload["migrationFile"]).read_text()
        assert payload["operationCount"] == 7
        assert len(extract_executable_statements(sql)) == payload["operationCount"]
        comment_texts = [
            "attendee", "hash comment", "person's own company", "/* block", "trailing comment",
            "monthly partitions", "keep ten years", "one row per person",
        ]
        assert [text for text in comment_texts if text in sql] == []
        assert f"'{MARKER}'" in sql

        # 2. ClickHouse accepts every statement.
        migrated = _invoke_with_retry(runner, ["migrate", "--execute", "--json"])
        assert migrated.exit_code == 0, format_test_diagnostic("migrate --execute failed", migrated)

        # 3. The view holds the whole query, not the text before a comment.
        [stored] = _wait_for_rows(
            client,
            f"SELECT as_select FROM system.tables WHERE database = '{database}' "
            f"AND name = '{names['meeting_view']}'",
            lambda rows: len(rows) == 1,
        )
        assert "meeting_company" in stored["as_select"]
        assert f"'{MARKER}'" in stored["as_select"]

        # 4. The view and the materialized view return the full query's rows.
        client.command(
            f"INSERT INTO {obj(names['people'])} (person_id, company_id, emails) "
            "VALUES (1, 10, ['a@x.io', 'b@x.io']), (2, 20, ['c@y.io'])"
        )
        meeting_rows = _wait_for_rows(
            client,
            "SELECT email, toString(company_id) AS company_id, marker "
            f"FROM {obj(names['meeting_view'])} ORDER BY email",
            lambda rows: len(rows) == 3,
        )
        assert meeting_rows == [
            {"email": "a@x.io", "company_id": "10", "marker": MARKER},
            {"email": "b@x.io", "company_id": "10", "marker": MARKER},
            {"email": "c@y.io", "company_id": "20", "marker": MARKER},
        ]
        count_rows = _wait_for_rows(
            client,
            "SELECT toString(company_id) AS company_id, toString(sum(n)) AS n "
            f"FROM {obj(names['counts'])} GROUP BY company_id ORDER BY company_id",
            lambda rows: len(rows) == 2,
        )
        assert count_rows == [{"company_id": "10", "n": "1"}, {"company_id": "20", "n": "1"}]

        # 5. ClickHouse stores no comments; the commented TTL, partition and
        #    expression default still compare clean, and so do the backticked
        #    keys ClickHouse reports for the visits table.
        drift = runner.invoke(app, ["drift", "--live", "--table", f"{database}.{prefix}*", "--json"])
        assert drift.exit_code == 0, format_test_diagnostic("drift failed", drift)
        drift_payload = json.loads(drift.stdout)
        assert drift_payload["tableDrift"] == []
        assert drift_payload["drifted"] is False

        # 6. The snapshot round-trips, and editing a comment is not a change.
        def planned_operations() -> list[Any]:
            planned = runner.invoke(app, ["generate", "--dryrun", "--json"])
            assert planned.exit_code == 0, format_test_diagnostic("generate --dryrun failed", planned)
            return list(json.loads(planned.stdout)["operations"])

        assert planned_operations() == []
        schema_path.write_text(_render_schema(names, "Edited: resolved through the person record."))
        assert planned_operations() == []
    finally:
        for view in [names["meeting_view"], names["follow_up_view"]]:
            client.command(f"DROP VIEW IF EXISTS {obj(view)}")
        client.command(f"DROP TABLE IF EXISTS {obj(names['counts_mv'])}")
        for tbl in [names["people"], names["counts"], names["visits"], journal_table]:
            client.command(f"DROP TABLE IF EXISTS {obj(tbl)}")
