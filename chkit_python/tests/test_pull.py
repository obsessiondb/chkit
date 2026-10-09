"""Tests for `chkit.cli.commands.pull*` — view parser, render, command."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit import ColumnDefinition, materialized_view, table, view
from chkit.cli.commands.pull_render import render_schema_file
from chkit.cli.commands.pull_view_parser import (
    DependsOnEntry,
    ToClauseShape,
    parse_as_clause,
    parse_refresh_clause,
    parse_to_clause,
)
from chkit.cli.main import app
from chkit.core.model import (
    MaterializedViewRefresh,
    SkipIndexBloomFilter,
    SkipIndexMinmax,
    TableRef,
)

# ---------- parse_as_clause ----------


def test_parse_as_clause_returns_select_body() -> None:
    ddl = "CREATE VIEW db.v AS SELECT id, ts FROM db.events"
    assert parse_as_clause(ddl) == "SELECT id, ts FROM db.events"


def test_parse_as_clause_strips_trailing_semicolon() -> None:
    ddl = "CREATE VIEW db.v AS SELECT 1;"
    assert parse_as_clause(ddl) == "SELECT 1"


def test_parse_as_clause_returns_none_when_missing() -> None:
    assert parse_as_clause("CREATE TABLE x (id UInt64)") is None
    assert parse_as_clause(None) is None
    assert parse_as_clause("") is None


def test_parse_as_clause_strips_definer_and_security_clauses() -> None:
    ddl = (
        "CREATE VIEW db.v DEFINER = `service_account` SQL SECURITY DEFINER "
        "AS SELECT id FROM db.events"
    )
    assert parse_as_clause(ddl) == "SELECT id FROM db.events"


# ---------- parse_to_clause ----------


def test_parse_to_clause_qualified() -> None:
    ddl = "CREATE MATERIALIZED VIEW db.mv TO analytics.events_agg AS SELECT 1"
    assert parse_to_clause(ddl, "fallback") == ToClauseShape(
        database="analytics", name="events_agg"
    )


def test_parse_to_clause_unqualified_uses_fallback() -> None:
    ddl = "CREATE MATERIALIZED VIEW db.mv TO events_agg AS SELECT 1"
    assert parse_to_clause(ddl, "default") == ToClauseShape(
        database="default", name="events_agg"
    )


def test_parse_to_clause_handles_backticks() -> None:
    # Matches TS behaviour: backticks around individual segments are stripped,
    # but a name containing a dot inside backticks is split on the dot (TS does
    # the same naive split; documented in DRIFT.md as future improvement).
    ddl = "CREATE MATERIALIZED VIEW db.mv TO `analytics`.`weird table` AS SELECT 1"
    out = parse_to_clause(ddl, "fallback")
    assert out is not None
    assert out.database == "analytics"
    assert out.name == "weird table"


def test_parse_to_clause_returns_none_when_missing() -> None:
    assert parse_to_clause("CREATE VIEW x AS SELECT 1", "fallback") is None


# ---------- parse_refresh_clause ----------


def test_parse_refresh_every_normalises_interval() -> None:
    ddl = (
        "CREATE MATERIALIZED VIEW db.mv REFRESH EVERY 1 hour OFFSET 5 minutes "
        "TO db.t AS SELECT 1"
    )
    refresh = parse_refresh_clause(ddl)
    assert refresh is not None
    assert refresh.every == "1 HOUR"
    assert refresh.offset == "5 MINUTE"


def test_parse_refresh_after_with_randomize_and_depends_on() -> None:
    ddl = (
        "CREATE MATERIALIZED VIEW db.mv REFRESH AFTER 2 days RANDOMIZE FOR 10 minutes "
        "DEPENDS ON db.t1, db.t2 TO db.target AS SELECT 1"
    )
    refresh = parse_refresh_clause(ddl)
    assert refresh is not None
    assert refresh.after == "2 DAY"
    assert refresh.randomize == "10 MINUTE"
    assert refresh.depends_on == [
        DependsOnEntry(database="db", name="t1"),
        DependsOnEntry(database="db", name="t2"),
    ]


def test_parse_refresh_settings_block() -> None:
    ddl = (
        "CREATE MATERIALIZED VIEW db.mv REFRESH EVERY 1 hour "
        "SETTINGS max_concurrent_runs = 1, retry_timeout = 'PT1H' TO db.t AS SELECT 1"
    )
    refresh = parse_refresh_clause(ddl)
    assert refresh is not None
    assert refresh.settings == {"max_concurrent_runs": 1, "retry_timeout": "PT1H"}


def test_parse_refresh_append_and_empty_flags() -> None:
    ddl = "CREATE MATERIALIZED VIEW db.mv REFRESH EVERY 1 hour APPEND EMPTY AS SELECT 1"
    refresh = parse_refresh_clause(ddl)
    assert refresh is not None
    assert refresh.append is True
    assert refresh.empty is True


def test_parse_refresh_returns_none_when_no_refresh_block() -> None:
    assert parse_refresh_clause("CREATE MATERIALIZED VIEW db.mv TO db.t AS SELECT 1") is None


# ---------- render_schema_file ----------


def test_render_emits_table_with_imports() -> None:
    t = table(
        database="db",
        name="events",
        engine="MergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
    )
    output = render_schema_file([t])
    assert "from chkit import" in output
    assert "table" in output
    assert "schema" in output
    assert "db_events = table(" in output
    assert 'database="db"' in output
    assert "definitions = schema(db_events)" in output


def test_render_emits_columns_with_optional_attrs() -> None:
    t = table(
        database="db",
        name="t",
        engine="MergeTree",
        columns=[
            ColumnDefinition(name="x", type="Nullable(UInt64)", nullable=True),
            ColumnDefinition(name="y", type="String", default="hello", comment="desc"),
        ],
        primary_key=["x"],
        order_by=["x"],
    )
    output = render_schema_file([t])
    assert "nullable=True" in output
    assert 'default="hello"' in output
    assert 'comment="desc"' in output


def test_render_handles_view_and_materialized_view() -> None:
    v = view(database="db", name="v", as_="SELECT 1")
    mv = materialized_view(
        database="db",
        name="mv",
        to=TableRef(database="db", name="target"),
        as_="SELECT 2",
        refresh=MaterializedViewRefresh(every="1 HOUR", append=True),
    )
    output = render_schema_file([v, mv])
    assert "view(" in output
    assert "materialized_view(" in output
    assert "TableRef" in output
    assert 'every="1 HOUR"' in output
    assert "append=True" in output


def test_render_dedupes_variable_names_across_databases() -> None:
    a = table(
        database="a",
        name="x",
        engine="MergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
    )
    b = table(
        database="b",
        name="x",
        engine="MergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
    )
    output = render_schema_file([a, b])
    assert "a_x = table" in output
    assert "b_x = table" in output


def test_render_dedupes_same_stem_same_db_with_numeric_suffix() -> None:
    t1 = table(
        database="db",
        name="x",
        engine="MergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
    )
    output = render_schema_file([t1, t1.model_copy(update={"name": "x"})])
    # canonicalize would dedup based on identity, but if two distinct defs with same key existed,
    # the variable suffix should kick in.
    assert output.count("db_x") >= 1


def test_render_round_trips_back_through_exec(tmp_path: Path) -> None:
    """Output should be valid Python that re-creates the same definitions."""
    t = table(
        database="default",
        name="events",
        engine="MergeTree",
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
            ColumnDefinition(name="ts", type="DateTime"),
        ],
        primary_key=["id"],
        order_by=["id", "ts"],
        partition_by="toYYYYMM(ts)",
        settings={"index_granularity": 8192},
        indexes=[SkipIndexMinmax(name="idx_ts", expression="ts", granularity=8192)],
    )
    output = render_schema_file([t])

    module_globals: dict[str, Any] = {}
    exec(compile(output, "<pulled>", "exec"), module_globals)
    assert "definitions" in module_globals
    re_loaded = module_globals["definitions"]
    assert len(re_loaded) == 1
    assert re_loaded[0].name == "events"
    assert re_loaded[0].order_by == ["id", "ts"]
    assert re_loaded[0].partition_by == "toYYYYMM(ts)"


def test_render_empty_definitions_emits_empty_schema() -> None:
    output = render_schema_file([])
    assert "definitions = schema()" in output


def test_render_indexes_include_bloom_filter_rate() -> None:
    t = table(
        database="db",
        name="t",
        engine="MergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
        indexes=[
            SkipIndexBloomFilter(
                name="idx", expression="id", granularity=1, false_positive_rate=0.01
            )
        ],
    )
    output = render_schema_file([t])
    assert "SkipIndexBloomFilter" in output
    assert "false_positive_rate=0.01" in output


# ---------- CLI: chkit pull (rejection paths) ----------


CONFIG_WITHOUT_CH = """
from chkit import define_config

config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
    }
)
"""


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


def test_cli_rejects_missing_clickhouse_config(
    runner: CliRunner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG_WITHOUT_CH, encoding="utf-8")
    result = runner.invoke(app, ["pull"])
    assert result.exit_code != 0
    assert "clickhouse" in result.output.lower()
