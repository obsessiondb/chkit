"""Port of ``packages/cli/src/test/migrate-dependency-order.e2e.test.ts`` (#231).

Objects whose names sort against their dependencies, so the old kind-then-name
order fails at the steps ClickHouse validates:

- a_top -> b_mid -> c_base -> events: stacked views. b_mid reads c_base
  unqualified (resolved against the session database). b_mid's digit-led name
  sorts it before a_top, so a_top -> b_mid stays ordered only if the lexer
  reads ``1…b_mid`` as a name.
- a_mv_reader -> m_mv: a view reading a materialized view.
- a_named -> d and a_events -> d: a view calling dictGet, and a column DEFAULT
  dictGet (written as ``SQLExpression``), on a dictionary created in the same
  migration; d reads src through a CLICKHOUSE(TABLE … DB …) source.
- a_named_ident -> d: dictGet naming the dictionary by a bare identifier.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from tests.e2e_testkit import (
    create_journal_table_name,
    create_prefix,
    format_test_diagnostic,
    quote_ident,
    resolve_live_env,
)


def _object_name(prefix: str, name: str) -> str:
    # b_mid's name starts with a digit; ClickHouse reads that as a name.
    return f"1{prefix}{name}" if name == "b_mid" else f"{prefix}{name}"


def _render_schema(
    *, db: str, prefix: str, base_filter: str, mid_filter: str, with_dictionary: bool
) -> str:
    def n(name: str) -> str:
        return _object_name(prefix, name)

    def tbl(var: str, name: str, columns: str, key: str) -> str:
        return (
            f"{var} = table(database={db!r}, name={n(name)!r}, columns={columns}, "
            f"engine='MergeTree()', primary_key=[{key!r}], order_by=[{key!r}])\n"
        )

    def vw(var: str, name: str, as_: str) -> str:
        return f"{var} = view(database={db!r}, name={n(name)!r}, as_={as_!r})\n"

    out = "from chkit import SQLExpression, dictionary, materialized_view, schema, table, view\n\n"
    out += tbl("events", "events",
               "[{'name': 'id', 'type': 'UInt64'}, {'name': 'kind', 'type': 'String'}]", "id")
    out += tbl("counts", "counts",
               "[{'name': 'kind', 'type': 'String'}, {'name': 'n', 'type': 'UInt64'}]", "kind")
    out += vw("c_base", "c_base", f"SELECT id, kind FROM {db}.{n('events')} WHERE {base_filter}")
    out += vw("b_mid", "b_mid", f"SELECT id, kind FROM {n('c_base')} WHERE {mid_filter}")
    out += vw("a_top", "a_top", f"SELECT count() AS n FROM {db}.{n('b_mid')}")
    mv_as = f"SELECT kind, count() AS n FROM {db}.{n('events')} GROUP BY kind"
    out += (
        f"m_mv = materialized_view(database={db!r}, name={n('m_mv')!r}, "
        f"to={{'database': {db!r}, 'name': {n('counts')!r}}}, as_={mv_as!r})\n"
    )
    out += vw("a_mv_reader", "a_mv_reader", f"SELECT kind, n FROM {db}.{n('m_mv')}")
    exports = "events, counts, c_base, b_mid, a_top, m_mv, a_mv_reader"
    if with_dictionary:
        source = f"CLICKHOUSE(TABLE '{n('src')}' DB '{db}')"
        out += tbl("src", "src",
                   "[{'name': 'id', 'type': 'UInt64'}, {'name': 'name', 'type': 'String'}]", "id")
        out += (
            f"d = dictionary(database={db!r}, name={n('d')!r}, "
            "attributes=[{'name': 'id', 'type': 'UInt64'}, {'name': 'name', 'type': 'String'}], "
            f"primary_key=['id'], source={source!r}, "
            "layout='FLAT()', lifetime='0')\n"
        )
        dict_get = f"dictGet('{db}.{n('d')}', 'name', id)"
        out += tbl(
            "a_events", "a_events",
            "[{'name': 'id', 'type': 'UInt64'}, {'name': 'name', 'type': 'String', "
            f"'default': SQLExpression(expression={dict_get!r})}}]",
            "id",
        )
        out += vw("a_named", "a_named", f"SELECT id, {dict_get} AS name FROM {db}.{n('events')}")
        out += vw("a_named_ident", "a_named_ident",
                  f"SELECT id, dictGet({n('d')}, 'name', id) AS name FROM {db}.{n('events')}")
        exports += ", src, d, a_events, a_named, a_named_ident"
    return out + f"\ndefinitions = schema({exports})\n"


def _markers(sql: str) -> list[str]:
    return re.findall(r"^-- operation: (\S+) key=(.+?) risk=", sql, re.MULTILINE)


def _assert_in_order(sql: str, keys: list[str]) -> None:
    order = [key for _, key in _markers(sql)]
    missing = [key for key in keys if key not in order]
    assert missing == []
    positions = [order.index(key) for key in keys]
    assert positions == sorted(positions), (keys, order)


def _poll_until(read: Callable[[], int], done: Callable[[int], bool], timeout: float = 60) -> int:
    deadline = time.monotonic() + timeout
    value = read()
    while not done(value) and time.monotonic() < deadline:
        time.sleep(1)
        value = read()
    return value


def _run_migrate(runner: CliRunner, args: list[str], attempts: int = 3) -> Any:
    # ObsessionDB DDL is eventually consistent; a rerun resumes the journal.
    result = runner.invoke(app, args)
    for _ in range(attempts - 1):
        if result.exit_code == 0:
            break
        time.sleep(2)
        result = runner.invoke(app, args)
    return result


def test_creates_and_drops_objects_in_dependency_order(  # noqa: PLR0915
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = ch_client._client
    env = resolve_live_env()
    db = client.database
    journal_table = create_journal_table_name("deporder_py")
    p = create_prefix("deporder")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")
    runner = CliRunner()

    def n(name: str) -> str:
        return _object_name(p, name)

    def obj(name: str) -> str:
        return f"{quote_ident(db)}.{quote_ident(n(name))}"

    def key(kind: str, name: str) -> str:
        return f"{kind}:{db}.{n(name)}"

    def count_rows(sql: str) -> int:
        rows = client.query(sql).result_rows
        return int(rows[0][0]) if rows else -1

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
                "database": db,
            },
        })
        + ")\n"
    )
    schema_path = tmp_path / "schema.py"
    migrations = tmp_path / "chkit" / "migrations"
    try:
        # 1. Initial create: every object lands after the objects it reads.
        schema_path.write_text(_render_schema(
            db=db, prefix=p, base_filter="id > 0", mid_filter="id > 0", with_dictionary=True))
        gen = runner.invoke(
            app, ["generate", "--name", "init", "--migration-id", "20990101000000", "--json"])
        assert gen.exit_code == 0, format_test_diagnostic("generate (init) failed", gen)
        init_sql = (migrations / "20990101000000_init.sql").read_text()
        _assert_in_order(init_sql, [key("view", "c_base"), key("view", "b_mid"),
                                    key("view", "a_top")])
        _assert_in_order(init_sql, [key("materialized_view", "m_mv"), key("view", "a_mv_reader")])
        _assert_in_order(init_sql, [key("dictionary", "d"), key("table", "a_events")])
        _assert_in_order(init_sql, [key("dictionary", "d"), key("view", "a_named")])
        _assert_in_order(init_sql, [key("dictionary", "d"), key("view", "a_named_ident")])
        # The SQLExpression default renders as SQL, not a quoted literal.
        assert f"DEFAULT dictGet('{db}.{n('d')}', 'name', id)" in init_sql

        migrate = _run_migrate(runner, ["migrate", "--execute", "--json"])
        assert migrate.exit_code == 0, format_test_diagnostic("migrate (init) failed", migrate)

        client.command(f"INSERT INTO {obj('events')} (id, kind) VALUES (1, 'a'), (2, 'b'), (3, 'b')")
        read_top = lambda: count_rows(f"SELECT n FROM {obj('a_top')}")  # noqa: E731
        assert _poll_until(read_top, lambda c: c == 3) == 3
        read_mv = lambda: count_rows(f"SELECT count() AS n FROM {obj('a_mv_reader')}")  # noqa: E731
        assert _poll_until(read_mv, lambda c: c == 2) == 2

        # 2. Change the base view and its reader, and remove the dictionary
        # with everything around it. ClickHouse refuses to drop a dictionary
        # while a column default calls it, and a table while a dictionary
        # sources from it; the base view must exist again before its reader.
        schema_path.write_text(_render_schema(
            db=db, prefix=p, base_filter="kind != 'skip'", mid_filter="id > 1",
            with_dictionary=False))
        gen = runner.invoke(
            app, ["generate", "--name", "restack", "--migration-id", "20990101000001", "--json"])
        assert gen.exit_code == 0, format_test_diagnostic("generate (restack) failed", gen)
        restack_sql = (migrations / "20990101000001_restack.sql").read_text()
        # Views are dropped and recreated under the same key, so drops and
        # creates are checked separately; drops all run before creates.
        drops = [k for t, k in _markers(restack_sql) if t.startswith("drop_")]
        creates = [k for t, k in _markers(restack_sql) if t.startswith("create_")]
        assert drops.index(key("table", "a_events")) < drops.index(key("dictionary", "d"))
        assert drops.index(key("dictionary", "d")) < drops.index(key("table", "src"))
        assert creates.index(key("view", "c_base")) < creates.index(key("view", "b_mid"))
        kinds = [t for t, _ in _markers(restack_sql)]
        last_drop = max(i for i, t in enumerate(kinds) if t.startswith("drop_"))
        assert all(not t.startswith("create_") for t in kinds[: last_drop + 1])

        migrate = _run_migrate(runner, ["migrate", "--execute", "--allow-destructive", "--json"])
        assert migrate.exit_code == 0, format_test_diagnostic("migrate (restack) failed", migrate)
        assert _poll_until(read_top, lambda c: c == 2) == 2
        removed = ", ".join(
            f"'{n(name)}'" for name in ["a_events", "d", "src", "a_named", "a_named_ident"])
        read_removed = lambda: count_rows(  # noqa: E731
            f"SELECT count() FROM system.tables WHERE database = '{db}' AND name IN ({removed})")
        assert _poll_until(read_removed, lambda c: c == 0) == 0
    finally:
        for name in ["a_named", "a_named_ident", "a_mv_reader", "a_top", "b_mid", "c_base"]:
            client.command(f"DROP VIEW IF EXISTS {obj(name)}")
        client.command(f"DROP TABLE IF EXISTS {obj('m_mv')}")
        client.command(f"DROP TABLE IF EXISTS {obj('a_events')}")
        client.command(f"DROP DICTIONARY IF EXISTS {obj('d')}")
        for name in ["src", "counts", "events"]:
            client.command(f"DROP TABLE IF EXISTS {obj(name)}")
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)}")
