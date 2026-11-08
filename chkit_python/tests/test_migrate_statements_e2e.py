"""migrate --apply hands plugins and ClickHouse the same statements as TS (#486).

Port of ``packages/cli/src/test/migrate-statements.e2e.test.ts``: the migration
of ``test/fixtures/sql-splitter.json`` runs through ``migrate --apply`` with a
probe plugin that records what ``on_before_apply`` gets. Both ports must hand it
the fixture's statements. The test also records what clickhouse-connect sends
over HTTP: the statement without its trailing ``;``, which the driver drops,
as ``@clickhouse/client`` does.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from clickhouse_connect.driver.httpclient import HttpClient
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

FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[2] / "test/fixtures/sql-splitter.json").read_text(
        encoding="utf-8"
    )
)

PROBE_PLUGIN = """
import json
from pathlib import Path

from chkit.plugins import ChxPlugin, ChxPluginManifest


class _Probe:
    def on_before_apply(self, ctx):
        Path("statements.json").write_text(json.dumps(list(ctx.statements)))


def probe():
    return ChxPlugin(manifest=ChxPluginManifest(name="probe"), hooks=_Probe())
"""


@pytest.fixture
def live() -> Iterator[ClickHouseClient]:
    env = resolve_live_env()
    with ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    ) as client:
        yield client


def test_on_before_apply_gets_the_fixture_statements_and_they_keep_their_meaning(
    live: ClickHouseClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = resolve_live_env()
    database = live.database
    table = f"{create_prefix('stmts_py')}t"
    journal_table = create_journal_table_name("stmts_py")

    def render(text: str) -> str:
        return text.replace("{database}", database).replace("{table}", table)

    expected = [render(statement) for statement in FIXTURE["migration"]["statements"]]
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    (tmp_path / "probe_plugin.py").write_text(PROBE_PLUGIN, encoding="utf-8")
    config = {
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
    }
    (tmp_path / "clickhouse.config.py").write_text(
        "from chkit import define_config\nfrom probe_plugin import probe\n\n"
        f"config = define_config({json.dumps(config)[:-1]}, \"plugins\": [probe()]}})\n",
        encoding="utf-8",
    )
    migrations = tmp_path / "chkit" / "migrations"
    migrations.mkdir(parents=True)
    (migrations / "20990101000000_statements.sql").write_text(
        render(FIXTURE["migration"]["sql"]), encoding="utf-8"
    )

    sent: list[Any] = []
    raw_request = HttpClient._raw_request

    def record(self: HttpClient, data: Any, *args: Any, **kwargs: Any) -> Any:
        sent.append(data)
        return raw_request(self, data, *args, **kwargs)

    monkeypatch.setattr(HttpClient, "_raw_request", record)
    target = f"{quote_ident(database)}.{quote_ident(table)}"
    try:
        result = CliRunner().invoke(app, ["migrate", "--apply", "--json"])
        assert result.exit_code == 0, format_test_diagnostic("migrate --apply failed", result)
        assert json.loads((tmp_path / "statements.json").read_text(encoding="utf-8")) == expected
        # The driver drops the trailing `;` before it sends a statement.
        for statement in expected:
            assert statement[:-1] in sent

        # The strings, the heredoc and the quoted name reached ClickHouse whole.
        live.execute(f"INSERT INTO {target} (id) VALUES (1)")
        rows = poll_until(
            lambda: live.query(
                f"SELECT note, `odd\\`--;name` AS odd, extra FROM {target}"
            ).rows,
            lambda found: len(found) == 1,
        )
        assert rows == [
            {
                "note": "a -- b; it's 'c'",
                "odd": " -- not a comment; still the string ",
                "extra": "semi;colon",
            }
        ]
    finally:
        live.execute(f"DROP TABLE IF EXISTS {target}")
        live.execute(f"DROP TABLE IF EXISTS {quote_ident(database)}.{quote_ident(journal_table)}")
