"""Port of ``packages/cli/src/test/backfill-asterisk-columns.e2e.test.ts`` (chkit#243, #291).

Backfill chunks run ``INSERT INTO t SELECT * FROM t``. A user profile with
``asterisk_include_materialized_columns`` / ``asterisk_include_alias_columns``
enabled adds MATERIALIZED and ALIAS columns to ``*``, but not to the INSERT's
implicit column list. Without pinning those settings in the chunk query, copy
mode fails with NUMBER_OF_COLUMNS_DOESNT_MATCH, and an mv_replay of a
``SELECT *`` view whose target has one more column silently shifts values.

The profile is simulated by giving every ``clickhouse_connect`` client the
CLI opens those settings as client-level settings, which are sent with each
request: the same layer a server-side settings profile sets.

Requires a reachable ClickHouse (see ``tests/e2e_testkit.py``). Hard-fails when
the server is unreachable; never skips.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import clickhouse_connect  # type: ignore[import-untyped]
import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_column_absent, wait_for_table
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.e2e_testkit import (
    LiveEnv,
    create_prefix,
    poll_until,
    resolve_live_env,
    run_once_visible,
)

PROFILE_SETTINGS = {
    "asterisk_include_materialized_columns": 1,
    "asterisk_include_alias_columns": 1,
}

CONFIG_TEMPLATE = """
from chkit import define_config
from chkit_plugin_backfill import backfill

config = define_config(
    {{
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "clickhouse": {{
            "url": {url!r},
            "username": {user!r},
            "password": {password!r},
            "database": {database!r},
        }},
        "plugins": [backfill()],
    }}
)
"""

EMPTY_SCHEMA = """
from chkit import schema

definitions = schema()
"""


@dataclass(frozen=True)
class _Ctx:
    env: LiveEnv
    db: ClickHouseClient
    profiled: ClickHouseClient
    project: Path
    runner: CliRunner


@pytest.fixture
def ctx(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[_Ctx]:
    env = resolve_live_env()
    config = ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=env.clickhouse_url.startswith("https"),
    )
    try:
        db = ClickHouseClient.connect(config)
        db.query("SELECT 1")
    except Exception as exc:  # never skip on an unreachable server
        pytest.fail(f"ClickHouse unreachable at {env.clickhouse_url}: {exc!r}", pytrace=False)

    # `db` (opened above) has no profile. Every client opened after this point
    # (the CLI's planner and run executor, and `profiled`) carries it.
    original_get_client: Callable[..., Any] = clickhouse_connect.get_client

    def profiled_get_client(*args: Any, **kwargs: Any) -> Any:
        settings = {**(kwargs.pop("settings", None) or {}), **PROFILE_SETTINGS}
        return original_get_client(*args, **kwargs, settings=settings)

    monkeypatch.setattr(clickhouse_connect, "get_client", profiled_get_client)
    profiled = ClickHouseClient.connect(config)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(
        CONFIG_TEMPLATE.format(
            url=env.clickhouse_url,
            user=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
        ),
        encoding="utf-8",
    )
    (tmp_path / "schema.py").write_text(EMPTY_SCHEMA, encoding="utf-8")
    try:
        yield _Ctx(env=env, db=db, profiled=profiled, project=tmp_path, runner=CliRunner())
    finally:
        db.close()
        profiled.close()


def test_copy_keeps_stored_default_values_and_recomputes_materialized_alias_columns(
    ctx: _Ctx,
) -> None:
    star_columns, rows = _run_copy_backfill(
        ctx,
        label="bf_asterisk_mat",
        columns="""
            id UInt64,
            event_time DateTime,
            a String,
            m String MATERIALIZED concat(a, '_m'),
            al String ALIAS concat(a, '_al'),
            d String DEFAULT 'dflt',
            b String""",
        insert="""(id, event_time, a, d, b) VALUES
            (1, '2026-01-01 12:00:00', 'x', 'custom', 'bx'),
            (2, '2026-01-02 12:00:00', 'y', 'dflt', 'by')""",
        read_columns=["id", "a", "m", "al", "d", "b"],
    )

    assert star_columns == ["id", "event_time", "a", "m", "d", "b", "al"]
    assert rows == [
        {"id": "1", "a": "x", "m": "x_m", "al": "x_al", "d": "custom", "b": "bx", "copies": "2"},
        {"id": "2", "a": "y", "m": "y_m", "al": "y_al", "d": "dflt", "b": "by", "copies": "2"},
    ]


def test_copy_of_a_table_with_ephemeral_inputs_keeps_the_stored_defaults_derived_from_them(
    ctx: _Ctx,
) -> None:
    star_columns, rows = _run_copy_backfill(
        ctx,
        label="bf_asterisk_eph",
        columns="""
            id UInt64,
            event_time DateTime,
            e String EPHEMERAL,
            a String DEFAULT upper(e),
            al String ALIAS concat(a, '_al'),
            b String""",
        insert="""(id, event_time, e, b) VALUES
            (1, '2026-01-01 12:00:00', 'x', 'bx'),
            (2, '2026-01-02 12:00:00', 'y', 'by')""",
        read_columns=["id", "a", "al", "b"],
    )

    assert star_columns == ["id", "event_time", "a", "b", "al"]
    assert rows == [
        {"id": "1", "a": "X", "al": "X_al", "b": "bx", "copies": "2"},
        {"id": "2", "a": "Y", "al": "Y_al", "b": "by", "copies": "2"},
    ]


# chkit#291: an mv_replay of a `SELECT *` view writes each target column by
# name, as ClickHouse does when the view inserts into its TO table, whatever the
# target's column order or extra DEFAULT/MATERIALIZED/ALIAS columns. The source
# has a MATERIALIZED column the widened profile would add to `*`.


def test_mv_replay_fills_an_extra_default_column_of_a_target_outside_the_schema(
    ctx: _Ctx,
) -> None:
    rows = _run_mv_replay(
        ctx,
        label="bf_mv_default",
        target_columns="id UInt64, event_time DateTime, a String, b String, x String DEFAULT 'xd'",
        read_columns=["id", "a", "b", "x"],
    )
    assert rows == [{"id": "1", "a": "x", "b": "bx", "x": "xd"}]


def test_mv_replay_matches_reordered_target_columns_by_name(ctx: _Ctx) -> None:
    rows = _run_mv_replay(
        ctx,
        label="bf_mv_reorder",
        target_columns=(
            "b String, x String DEFAULT concat(a, '_xd'), a String, event_time DateTime, id UInt64"
        ),
        read_columns=["id", "a", "b", "x"],
    )
    assert rows == [{"id": "1", "a": "x", "b": "bx", "x": "x_xd"}]


def test_mv_replay_recomputes_materialized_and_alias_target_columns(ctx: _Ctx) -> None:
    rows = _run_mv_replay(
        ctx,
        label="bf_mv_computed",
        target_columns=(
            "id UInt64, event_time DateTime, a String, b String, "
            "m String MATERIALIZED concat(a, '_tm'), al String ALIAS concat(b, '_al')"
        ),
        read_columns=["id", "a", "b", "m", "al"],
    )
    assert rows == [{"id": "1", "a": "x", "b": "bx", "m": "x_tm", "al": "bx_al"}]


def test_mv_replay_fills_an_extra_default_column_of_a_target_declared_in_the_schema(
    ctx: _Ctx,
) -> None:
    rows = _run_mv_replay(
        ctx,
        label="bf_mv_declared",
        target_columns="event_time DateTime, x String DEFAULT 'xd', b String, a String, id UInt64",
        declare_target=(
            '[{"name": "event_time", "type": "DateTime"}, '
            '{"name": "x", "type": "String", "default": "xd"}, '
            '{"name": "b", "type": "String"}, {"name": "a", "type": "String"}, '
            '{"name": "id", "type": "UInt64"}]'
        ),
        read_columns=["id", "a", "b", "x"],
    )
    assert rows == [{"id": "1", "a": "x", "b": "bx", "x": "xd"}]


def test_mv_replay_refuses_to_plan_when_the_target_lacks_a_column_the_view_outputs(
    ctx: _Ctx,
) -> None:
    with _mv_replay_fixture(
        ctx, label="bf_mv_missing", target_columns="id UInt64, event_time DateTime, a String"
    ) as (_prefix, target):
        result = ctx.runner.invoke(app, ["plugin", "backfill", "plan", "--target", target, "--json"])
        assert result.exit_code == 2, result.output
        assert (
            f"outputs column(s) b, which {target} cannot take (missing, MATERIALIZED or ALIAS)"
            in result.output
        )


def test_mv_replay_refuses_to_run_a_plan_whose_target_lost_a_replayed_column(
    ctx: _Ctx,
) -> None:
    database = ctx.env.clickhouse_database
    with _mv_replay_fixture(
        ctx,
        label="bf_mv_altered",
        target_columns="id UInt64, event_time DateTime, a String, b String, x String DEFAULT 'xd'",
    ) as (prefix, target):
        planned = _invoke_json(ctx, ["plugin", "backfill", "plan", "--target", target, "--json"])
        assert planned["strategy"] == "mv_replay"
        ctx.db.execute(f"ALTER TABLE {target} DROP COLUMN b")
        wait_for_column_absent(ctx.db, database, f"{prefix}target", "b")

        result = ctx.runner.invoke(
            app,
            ["plugin", "backfill", "run", "--plan-id", planned["planId"],
             "--poll-interval", "500", "--json"],
        )
        assert result.exit_code == 2, result.output
        assert (
            f"Target {target} changed since plan {planned['planId']} was created: "
            "column(s) b are gone or no longer insertable"
        ) in result.output
        assert _count_rows(ctx.db, target) == 0


def _run_mv_replay(
    ctx: _Ctx,
    *,
    label: str,
    target_columns: str,
    read_columns: list[str],
    declare_target: str | None = None,
) -> list[dict[str, str]]:
    """Plan and run an mv_replay backfill of a ``SELECT *`` view from the shared
    source shape into a target with ``target_columns``, under the widened
    profile, and return the target's rows as strings."""
    with _mv_replay_fixture(
        ctx, label=label, target_columns=target_columns, declare_target=declare_target
    ) as (_prefix, target):
        planned = _invoke_json(ctx, ["plugin", "backfill", "plan", "--target", target, "--json"])
        assert planned["strategy"] == "mv_replay"
        ran = _invoke_json(
            ctx,
            ["plugin", "backfill", "run", "--plan-id", planned["planId"],
             "--poll-interval", "500", "--json"],
        )
        assert ran["status"] == "completed"

        _wait_for_row_count(ctx.db, target, 1)
        projection = ", ".join(f"toString({column}) AS {column}" for column in read_columns)
        rows = ctx.db.query(
            f"SELECT {projection} FROM {target} ORDER BY id "
            f"SETTINGS select_sequential_consistency = 1"
        ).rows
        return [{key: str(value) for key, value in row.items()} for row in rows]


@contextmanager
def _mv_replay_fixture(
    ctx: _Ctx, *, label: str, target_columns: str, declare_target: str | None = None
) -> Iterator[tuple[str, str]]:
    """Create the source (with a MATERIALIZED column the profile adds to ``*``)
    and the target, insert one source row, and declare the ``SELECT *`` view
    (and optionally the target) in the schema. The view itself is never
    created: the replay reads its query from the schema. Yields the name prefix
    and the target's qualified name."""
    database = ctx.env.clickhouse_database
    prefix = create_prefix(label)
    source = f"{database}.{prefix}source"
    target = f"{database}.{prefix}target"
    try:
        ctx.db.execute(
            f"CREATE TABLE {source} (id UInt64, event_time DateTime, a String, "
            f"m String MATERIALIZED concat(a, '_m'), b String) ENGINE = MergeTree() "
            f"PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)"
        )
        ctx.db.execute(
            f"CREATE TABLE {target} ({target_columns}) ENGINE = MergeTree() "
            f"PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)"
        )
        wait_for_table(ctx.db, database, f"{prefix}source")
        wait_for_table(ctx.db, database, f"{prefix}target")
        run_once_visible(
            lambda: ctx.db.execute(
                f"INSERT INTO {source} (id, event_time, a, b) "
                f"VALUES (1, '2026-01-01 12:00:00', 'x', 'bx')"
            )
        )
        _wait_for_row_count(ctx.db, source, 1)

        declared_target = (
            f"""
    table(
        database={database!r},
        name={prefix + "target"!r},
        engine="MergeTree()",
        partition_by="toYYYYMMDD(event_time)",
        primary_key=["event_time", "id"],
        order_by=["event_time", "id"],
        columns={declare_target},
    ),"""
            if declare_target is not None
            else ""
        )
        (ctx.project / "schema.py").write_text(
            f"""
from chkit import materialized_view, schema, table

definitions = schema({declared_target}
    materialized_view(
        database={database!r},
        name={prefix + "mv"!r},
        to={{"database": {database!r}, "name": {prefix + "target"!r}}},
        as_={"SELECT * FROM " + source!r},
    )
)
""",
            encoding="utf-8",
        )
        yield prefix, target
    finally:
        ctx.db.execute(f"DROP TABLE IF EXISTS {source}")
        ctx.db.execute(f"DROP TABLE IF EXISTS {target}")


def _run_copy_backfill(
    ctx: _Ctx, *, label: str, columns: str, insert: str, read_columns: list[str]
) -> tuple[list[str], list[dict[str, str]]]:
    """Plan and run a copy backfill of a two-partition table through the CLI under
    the widened-asterisk profile. Returns what ``SELECT *`` exposes under that
    profile plus each distinct row with its number of copies."""
    database = ctx.env.clickhouse_database
    table = f"{create_prefix(label)}events"
    fqn = f"{database}.{table}"
    try:
        ctx.db.execute(
            f"CREATE TABLE {fqn} ({columns}) ENGINE = MergeTree() "
            f"PARTITION BY toYYYYMMDD(event_time) ORDER BY (event_time, id)"
        )
        wait_for_table(ctx.db, database, table)
        run_once_visible(lambda: ctx.db.execute(f"INSERT INTO {fqn} {insert}"))
        _wait_for_row_count(ctx.db, fqn, 2)

        # Guard against a vacuous test: the profile must actually widen `*`.
        star_columns = ctx.profiled.query(f"SELECT * FROM {fqn} LIMIT 1").column_names

        planned = _invoke_json(
            ctx,
            ["plugin", "backfill", "plan", "--target", fqn,
             "--from", "2026-01-01T00:00:00.000Z", "--to", "2026-01-03T00:00:00.000Z", "--json"],
        )
        assert planned["strategy"] == "copy"
        ran = _invoke_json(
            ctx,
            ["plugin", "backfill", "run", "--plan-id", planned["planId"],
             "--poll-interval", "500", "--json"],
        )
        assert ran["status"] == "completed"

        # Copy mode re-inserts the table into itself, so each row ends up twice.
        _wait_for_row_count(ctx.db, fqn, 4)
        projection = ", ".join(f"toString({column}) AS {column}" for column in read_columns)
        rows = ctx.db.query(
            f"SELECT {projection}, toString(count()) AS copies FROM {fqn} "
            f"GROUP BY {', '.join(read_columns)} ORDER BY id "
            f"SETTINGS select_sequential_consistency = 1"
        ).rows
        return star_columns, [{key: str(value) for key, value in row.items()} for row in rows]
    finally:
        ctx.db.execute(f"DROP TABLE IF EXISTS {fqn}")


def _invoke_json(ctx: _Ctx, args: list[str]) -> dict[str, Any]:
    result = ctx.runner.invoke(app, args)
    assert result.exit_code == 0, result.output
    payload: dict[str, Any] = json.loads(result.output)
    return payload


def _count_rows(db: ClickHouseClient, fqn: str) -> int:
    rows = db.query(
        f"SELECT toString(count()) AS cnt FROM {fqn} SETTINGS select_sequential_consistency = 1"
    ).rows
    return int(str(rows[0]["cnt"]))


def _wait_for_row_count(db: ClickHouseClient, fqn: str, expected: int) -> None:
    count = poll_until(lambda: _count_rows(db, fqn), lambda value: value == expected, timeout=45.0)
    assert count == expected, f"rows in {fqn}"
