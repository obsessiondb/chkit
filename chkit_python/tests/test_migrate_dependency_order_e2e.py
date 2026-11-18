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


def _markers(sql: str) -> list[tuple[str, str]]:
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


def test_adds_a_column_before_the_add_column_whose_default_reads_it(
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `Total` sorts before `price` by code point, but its DEFAULT reads `price`
    # (#681). ClickHouse rejects the ADD COLUMN of `Total` while `price` is missing.
    client = ch_client._client
    env = resolve_live_env()
    db = client.database
    journal_table = create_journal_table_name("addorder_py")
    orders = f"{create_prefix('addorder')}orders"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")
    runner = CliRunner()
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

    def generate_and_migrate(columns: str, name: str, migration_id: str) -> str:
        (tmp_path / "schema.py").write_text(
            "from chkit import SQLExpression, schema, table\n\n"
            f"definitions = schema(table(database={db!r}, name={orders!r}, "
            f"columns=[{{'name': 'id', 'type': 'UInt64'}}{columns}], engine='MergeTree()', "
            "primary_key=['id'], order_by=['id']))\n"
        )
        gen = runner.invoke(
            app, ["generate", "--name", name, "--migration-id", migration_id, "--json"])
        assert gen.exit_code == 0, format_test_diagnostic(f"generate ({name}) failed", gen)
        migrate = _run_migrate(runner, ["migrate", "--execute", "--json"])
        assert migrate.exit_code == 0, format_test_diagnostic(f"migrate ({name}) failed", migrate)
        return (tmp_path / "chkit" / "migrations" / f"{migration_id}_{name}.sql").read_text()

    try:
        generate_and_migrate("", "init", "20990101000000")
        add_sql = generate_and_migrate(
            ", {'name': 'price', 'type': 'UInt64'}, {'name': 'Total', 'type': 'UInt64', "
            "'default': SQLExpression(expression='price + 1')}",
            "add",
            "20990101000001",
        )
        _assert_in_order(add_sql, [f"table:{db}.{orders}:column:price",
                                   f"table:{db}.{orders}:column:Total"])

        client.command(f"INSERT INTO {quote_ident(db)}.{quote_ident(orders)} (id, price) VALUES (1, 41)")
        rows = client.query(f"SELECT Total FROM {quote_ident(db)}.{quote_ident(orders)}").result_rows
        assert [int(row[0]) for row in rows] == [42]
    finally:
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(orders)}")
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)}")


def _e(sql: str) -> str:
    return f"'default': SQLExpression(expression={sql!r})"


_CONCAT_B = _e("concat(b, '!')")
_LENGTH_ABC = _e("length('abc')")


# Each change below fails on ClickHouse in the order of an earlier plan: a
# statement reads a column that does not exist yet, or a DROP COLUMN runs
# while another column still reads it (#745, #746, #758). `order` lists
# operation keys after the table prefix; `rename` is a `from=to` mapping.
_COLUMN_CHANGES: list[dict[str, Any]] = [
    {
        # #745: MODIFY COLUMN after the ADD COLUMN its new DEFAULT reads.
        "label": "modafteradd",
        "before": "{'name': 'Total', 'type': 'UInt64'}",
        "after": f"{{'name': 'Total', 'type': 'UInt64', {_e('price + 1')}}}, "
        "{'name': 'price', 'type': 'UInt64'}",
        "order": ["column:price", "column:Total"],
        "columns": ["Total", "id", "price"],
    },
    {
        # #746: RENAME COLUMN before the ADD COLUMN that reads the new name.
        "label": "addafterrename",
        "before": "{'name': 'a', 'type': 'String'}",
        "after": "{'name': 'b', 'type': 'String'}, {'name': 'Copy', 'type': 'String', "
        f"'default_kind': 'MATERIALIZED', {_CONCAT_B}}}",
        "rename": "a=b",
        "order": ["column_rename:a:b", "column:Copy"],
        "columns": ["Copy", "b", "id"],
    },
    {
        # #758: RENAME COLUMN before the MODIFY COLUMN that reads the new name.
        "label": "modafterrename",
        "before": f"{{'name': 'a', 'type': 'String'}}, {{'name': 'code', 'type': 'String', {_e('a')}}}",
        "after": f"{{'name': 'b', 'type': 'String'}}, {{'name': 'code', 'type': 'String', {_e('b')}}}",
        "rename": "a=b",
        "order": ["column_rename:a:b", "column:code"],
        "columns": ["b", "code", "id"],
    },
    {
        # Passes on main too; it fails when the DROP keeps its slot while the
        # MODIFY of `b` moves behind the ADD of `z`.
        "label": "dropaftermod",
        "before": f"{{'name': 'b', 'type': 'UInt64', {_e('c')}}}, {{'name': 'c', 'type': 'UInt64'}}",
        "after": f"{{'name': 'a', 'type': 'UInt64', {_e('z')}}}, "
        f"{{'name': 'b', 'type': 'UInt64', {_e('z')}}}, {{'name': 'z', 'type': 'UInt64'}}",
        "order": ["column:z", "column:b", "column:c"],
        "columns": ["a", "b", "id", "z"],
    },
    {
        "label": "dropafterdrop",
        "before": "{'name': 'a', 'type': 'UInt64'}, "
        f"{{'name': 'b', 'type': 'UInt64', 'default_kind': 'ALIAS', {_e('a + 1')}}}",
        "after": "{'name': 'x', 'type': 'UInt64'}",
        "order": ["column:b", "column:a"],
        "columns": ["id", "x"],
    },
    {
        # Passes on main too; it fails when the ADD and the RENAME move while
        # the MODIFY of `d` keeps its slot before the ADD of `c`.
        "label": "modaddrename",
        "before": "{'name': 'a', 'type': 'UInt64'}, {'name': 'd', 'type': 'UInt64'}",
        "after": f"{{'name': 'c', 'type': 'UInt64', {_LENGTH_ABC}}}, "
        f"{{'name': 'd', 'type': 'UInt64', {_e('c + 1')}}}, {{'name': 'length', 'type': 'UInt64'}}",
        "rename": "a=length",
        "order": ["column:c", "column:d"],
        "columns": ["c", "d", "id", "length"],
    },
    {
        # A function call named like the new column is no read of it.
        "label": "fnrename",
        "before": f"{{'name': 'a', 'type': 'UInt64', {_LENGTH_ABC}}}",
        "after": f"{{'name': 'b', 'type': 'UInt64', {_LENGTH_ABC}}}, "
        f"{{'name': 'length', 'type': 'UInt64', {_e('b + 1')}}}",
        "rename": "a=b",
        "order": ["column_rename:a:b", "column:length"],
        "columns": ["b", "id", "length"],
    },
    {
        # #768: reading the lambda parameter `c` as the new column `c` ran
        # MODIFY `a` last, so MODIFY `b` DEFAULT a met the old `a DEFAULT b`:
        # Cyclic alias detected in column DEFAULT expressions.
        "label": "lambdaparam",
        "before": f"{{'name': 'a', 'type': 'UInt64', {_e('b')}}}, "
        f"{{'name': 'b', 'type': 'UInt64', {_e('id')}}}",
        "after": f"{{'name': 'a', 'type': 'UInt64', {_e('arraySum(arrayMap(c -> c, [1]))')}}}, "
        f"{{'name': 'b', 'type': 'UInt64', {_e('a')}}}, {{'name': 'c', 'type': 'UInt64', {_e('id')}}}",
        "order": ["column:a", "column:b"],
        "columns": ["a", "b", "c", "id"],
    },
]


@pytest.mark.parametrize("change", _COLUMN_CHANGES, ids=[c["label"] for c in _COLUMN_CHANGES])
def test_orders_the_column_statements_of_a_table(
    change: dict[str, Any], ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = ch_client._client
    env = resolve_live_env()
    db = client.database
    journal_table = create_journal_table_name(f"{change['label']}_py")
    name = f"{create_prefix(change['label'])}t"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")
    runner = CliRunner()
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

    def generate_and_migrate(columns: str, step: str, migration_id: str, extra: list[str]) -> str:
        (tmp_path / "schema.py").write_text(
            "from chkit import SQLExpression, schema, table\n\n"
            f"definitions = schema(table(database={db!r}, name={name!r}, "
            f"columns=[{{'name': 'id', 'type': 'UInt64'}}, {columns}], engine='MergeTree()', "
            "primary_key=['id'], order_by=['id']))\n"
        )
        gen = runner.invoke(
            app, ["generate", "--name", step, "--migration-id", migration_id, *extra, "--json"])
        assert gen.exit_code == 0, format_test_diagnostic(f"generate ({step}) failed", gen)
        migrate = _run_migrate(runner, ["migrate", "--execute", "--allow-destructive", "--json"])
        assert migrate.exit_code == 0, format_test_diagnostic(f"migrate ({step}) failed", migrate)
        return (tmp_path / "chkit" / "migrations" / f"{migration_id}_{step}.sql").read_text()

    def read_columns() -> list[str]:
        rows = client.query(
            "SELECT name FROM system.columns WHERE database = {db:String} AND table = {t:String} "
            "ORDER BY name",
            parameters={"db": db, "t": name},
        ).result_rows
        return [str(row[0]) for row in rows]

    try:
        generate_and_migrate(change["before"], "init", "20990101000000", [])
        rename = change.get("rename")
        sql = generate_and_migrate(
            change["after"],
            "change",
            "20990101000001",
            [] if rename is None else ["--rename-column", f"{db}.{name}.{rename}"],
        )
        _assert_in_order(sql, [f"table:{db}.{name}:{key}" for key in change["order"]])

        expected = sorted(change["columns"])
        deadline = time.monotonic() + 30
        columns = read_columns()
        while columns != expected and time.monotonic() < deadline:
            time.sleep(0.5)
            columns = read_columns()
        assert columns == expected
    finally:
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(name)}")
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)}")


def test_drops_a_skip_index_before_the_column_it_reads_when_a_column_rename_is_applied(
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The DROP INDEX sorts after the DROP COLUMN by key (`column` < `index`);
    # the planner runs it first, and a rename in the same plan must keep that
    # (#747). ClickHouse rejects dropping `x` while `idx_x` reads it.
    client = ch_client._client
    env = resolve_live_env()
    db = client.database
    journal_table = create_journal_table_name("idxdrop_py")
    events = f"{create_prefix('idxdrop')}events"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")
    runner = CliRunner()
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

    def generate_and_migrate(
        columns: str, indexes: str, name: str, migration_id: str, extra_args: list[str]
    ) -> str:
        (tmp_path / "schema.py").write_text(
            "from chkit import schema, table\n\n"
            f"definitions = schema(table(database={db!r}, name={events!r}, "
            f"columns=[{{'name': 'id', 'type': 'UInt64'}}{columns}], indexes=[{indexes}], "
            "engine='MergeTree()', primary_key=['id'], order_by=['id']))\n"
        )
        gen = runner.invoke(
            app,
            ["generate", "--name", name, "--migration-id", migration_id, *extra_args, "--json"],
        )
        assert gen.exit_code == 0, format_test_diagnostic(f"generate ({name}) failed", gen)
        migrate = _run_migrate(runner, ["migrate", "--execute", "--allow-destructive", "--json"])
        assert migrate.exit_code == 0, format_test_diagnostic(f"migrate ({name}) failed", migrate)
        return (tmp_path / "chkit" / "migrations" / f"{migration_id}_{name}.sql").read_text()

    def read_columns() -> list[str]:
        rows = client.query(
            "SELECT name FROM system.columns WHERE database = {db:String} AND table = {t:String} "
            "ORDER BY name",
            parameters={"db": db, "t": events},
        ).result_rows
        return [str(row[0]) for row in rows]

    try:
        generate_and_migrate(
            ", {'name': 'a', 'type': 'String'}, {'name': 'x', 'type': 'String'}",
            "{'name': 'idx_x', 'expression': 'x', 'type': 'bloom_filter', 'granularity': 1}",
            "init",
            "20990101000000",
            [],
        )
        drop_sql = generate_and_migrate(
            ", {'name': 'b', 'type': 'String'}",
            "",
            "drop",
            "20990101000001",
            ["--rename-column", f"{db}.{events}.a=b"],
        )
        _assert_in_order(drop_sql, [
            f"table:{db}.{events}:index:idx_x",
            f"table:{db}.{events}:column:x",
            f"table:{db}.{events}:column_rename:a:b",
        ])

        deadline = time.monotonic() + 60
        columns = read_columns()
        while columns != ["b", "id"] and time.monotonic() < deadline:
            time.sleep(1)
            columns = read_columns()
        assert columns == ["b", "id"]
    finally:
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(events)}")
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)}")


def test_adds_a_dotted_column_before_the_add_column_whose_default_reads_it_unquoted(
    ch_client: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `a` sorts before `n.x`, and its DEFAULT reads `n.x` without backquotes
    # (#748). ClickHouse rejects the ADD COLUMN of `a` while `n.x` is missing.
    # Then `k.b` sorts before `z`, whose `t.1.k.b` is a path into the tuple `t`,
    # not a read of `k.b`; ClickHouse rejects `k.b DEFAULT z + 1` before `z`.
    client = ch_client._client
    env = resolve_live_env()
    db = client.database
    journal_table = create_journal_table_name("dotorder_py")
    orders = f"{create_prefix('dotorder')}orders"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", journal_table)
    monkeypatch.setenv("CI", "1")
    runner = CliRunner()
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

    def generate_and_migrate(columns: str, name: str, migration_id: str) -> str:
        (tmp_path / "schema.py").write_text(
            "from chkit import SQLExpression, schema, table\n\n"
            f"definitions = schema(table(database={db!r}, name={orders!r}, "
            f"columns=[{{'name': 'id', 'type': 'UInt64'}}, "
            f"{{'name': 't', 'type': 'Tuple(u Tuple(k Tuple(b UInt64)))'}}{columns}], "
            "engine='MergeTree()', "
            "primary_key=['id'], order_by=['id']))\n"
        )
        gen = runner.invoke(
            app, ["generate", "--name", name, "--migration-id", migration_id, "--json"])
        assert gen.exit_code == 0, format_test_diagnostic(f"generate ({name}) failed", gen)
        migrate = _run_migrate(runner, ["migrate", "--execute", "--json"])
        assert migrate.exit_code == 0, format_test_diagnostic(f"migrate ({name}) failed", migrate)
        return (tmp_path / "chkit" / "migrations" / f"{migration_id}_{name}.sql").read_text()

    try:
        generate_and_migrate("", "init", "20990101000000")
        add_sql = generate_and_migrate(
            ", {'name': 'a', 'type': 'UInt64', 'default': SQLExpression(expression='arraySum(n.x)')}, "
            "{'name': 'n.x', 'type': 'Array(UInt64)'}",
            "add",
            "20990101000001",
        )
        _assert_in_order(add_sql, [f"table:{db}.{orders}:column:n.x",
                                   f"table:{db}.{orders}:column:a"])

        client.command(
            f"INSERT INTO {quote_ident(db)}.{quote_ident(orders)} (id, `n.x`) VALUES (1, [40, 2])")
        rows = client.query(f"SELECT a FROM {quote_ident(db)}.{quote_ident(orders)}").result_rows
        assert [int(row[0]) for row in rows] == [42]

        element_sql = generate_and_migrate(
            ", {'name': 'a', 'type': 'UInt64', 'default': SQLExpression(expression='arraySum(n.x)')}, "
            "{'name': 'n.x', 'type': 'Array(UInt64)'}, "
            "{'name': 'k.b', 'type': 'UInt64', 'default': SQLExpression(expression='z + 1')}, "
            "{'name': 'z', 'type': 'UInt64', 'default': SQLExpression(expression='t.1.k.b')}",
            "element",
            "20990101000002",
        )
        _assert_in_order(element_sql, [f"table:{db}.{orders}:column:z",
                                       f"table:{db}.{orders}:column:k.b"])

        client.command(
            f"INSERT INTO {quote_ident(db)}.{quote_ident(orders)} (id, t) VALUES (2, (((41))))")
        rows = client.query(
            f"SELECT z, `k.b` FROM {quote_ident(db)}.{quote_ident(orders)} WHERE id = 2").result_rows
        assert [(int(row[0]), int(row[1])) for row in rows] == [(41, 42)]
    finally:
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(orders)}")
        client.command(f"DROP TABLE IF EXISTS {quote_ident(db)}.{quote_ident(journal_table)}")
