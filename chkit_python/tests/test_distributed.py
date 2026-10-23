"""Distributed and other keyless engines, matching packages/core/src/engine.test.ts (#279)."""

from __future__ import annotations

from pathlib import Path

import pytest

from chkit import table
from chkit.cli.commands.pull_render import render_schema_file
from chkit.cli.plugin_runtime import load_plugin_runtime
from chkit.cli.table_scope import TableScope
from chkit.core.canonical import canonicalize_definitions
from chkit.core.engine import supports_sort_order
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedClickHouseConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
    ChxValidationError,
    TableDefinition,
)
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from chkit.core.sql_normalizer import normalize_engine
from chkit.core.validate import validate_definitions
from chkit.plugins import ChxOnCheckContext, ChxOnSchemaLoadedContext
from chkit_plugin_obsessiondb import obsessiondb

COLUMNS = [{"name": "id", "type": "UInt64"}, {"name": "ts", "type": "DateTime"}]
DISTRIBUTED_MESSAGE = (
    "Table app.events uses the Distributed engine, which ObsessionDB does not support: "
    "ObsessionDB has no shards, so every replica already reads the same shared storage. "
    "Remove the Distributed table from the schema and query or insert into its local "
    "table directly."
)


def local(columns: list[dict[str, str]] = COLUMNS) -> TableDefinition:
    return table(
        database="app",
        name="events_local",
        engine="MergeTree()",
        columns=list(columns),
        primary_key=["id"],
        order_by=["id"],
        partition_by="toYYYYMM(ts)",
    )


def distributed(
    engine: str = "Distributed(cluster, app, events_local, rand())",
    columns: list[dict[str, str]] = COLUMNS,
    settings: dict[str, str | int | float | bool] | None = None,
) -> TableDefinition:
    return table(
        database="app", name="events", engine=engine, columns=list(columns), settings=settings
    )


# ---------- rendering + validation ----------


def test_renders_distributed_without_key_clauses() -> None:
    assert to_create_sql(distributed()) == (
        "CREATE TABLE IF NOT EXISTS app.events\n(\n  `id` UInt64,\n  `ts` DateTime\n)"
        " ENGINE = Distributed(cluster, app, events_local, rand())\n;"
    )


@pytest.mark.parametrize("engine", ["Memory", "Null", "Log", "Merge(app, '^events')"])
def test_renders_keyless_engines_without_key_clauses(engine: str) -> None:
    sql = to_create_sql(table(database="app", name="t", engine=engine, columns=COLUMNS))
    assert "PRIMARY KEY" not in sql
    assert "ORDER BY" not in sql


@pytest.mark.parametrize(
    "engine", ["MergeTree()", "ReplicatedMergeTree", "SharedReplacingMergeTree()"]
)
def test_keeps_key_clauses_on_merge_tree_engines(engine: str) -> None:
    sql = to_create_sql(local().model_copy(update={"engine": engine}))
    assert "PARTITION BY toYYYYMM(ts)\nPRIMARY KEY (`id`)\nORDER BY (`id`)" in sql
    empty = local().model_copy(update={"primary_key": [], "order_by": []})
    assert "PRIMARY KEY ()\nORDER BY ()" in to_create_sql(empty)


def test_merge_tree_table_still_requires_keys() -> None:
    with pytest.raises(ValueError, match="requires primary_key"):
        table(database="app", name="t", engine="MergeTree()", columns=COLUMNS)


def test_renders_only_the_keys_a_non_merge_tree_engine_sets() -> None:
    sql = to_create_sql(
        table(
            database="app",
            name="kv",
            engine="EmbeddedRocksDB",
            columns=COLUMNS,
            primary_key=["id"],
            order_by=[],
        )
    )
    assert "PRIMARY KEY (`id`)" in sql
    assert "ORDER BY" not in sql


@pytest.mark.parametrize(
    ("engine", "supported"),
    [
        ("MergeTree", True),
        ("ReplicatedAggregatingMergeTree(x)", True),
        ("SharedMergeTree", True),
        ("EmbeddedRocksDB", True),
        ("S3(url)", True),
        ("KeeperMap(path)", True),
        ("Distributed(c, d, t)", False),
        ("Memory", False),
        ("Null()", False),
        ("Buffer(d, t, 1, 1, 1, 1, 1, 1, 1)", False),
        ("Kafka", False),
        ("Merge(d, t)", False),
        ("Log", False),
    ],
)
def test_classifies_engines_by_sort_order_support(engine: str, supported: bool) -> None:
    assert supports_sort_order(engine) is supported


def test_rejects_keys_on_engines_that_do_not_support_them() -> None:
    issues = validate_definitions(
        [
            distributed().model_copy(update={"order_by": ["id"], "primary_key": ["id"]}),
            table(
                database="app",
                name="mem",
                engine="Memory",
                columns=COLUMNS,
                partition_by="toYYYYMM(ts)",
            ),
        ]
    )
    assert [(issue.code, issue.message) for issue in issues] == [
        (
            "engine_unsupported_clause",
            "Table app.events sets primaryKey, orderBy, but engine Distributed does not "
            "support PARTITION BY, PRIMARY KEY or ORDER BY (only MergeTree-family engines "
            "and a few others such as EmbeddedRocksDB, KeeperMap and S3 do). Remove them. "
            "Define the keys on the local table the Distributed table reads from.",
        ),
        (
            "engine_unsupported_clause",
            "Table app.mem sets partitionBy, but engine Memory does not support PARTITION BY, "
            "PRIMARY KEY or ORDER BY (only MergeTree-family engines and a few others such as "
            "EmbeddedRocksDB, KeeperMap and S3 do). Remove it.",
        ),
    ]
    with pytest.raises(ChxValidationError):
        to_create_sql(distributed().model_copy(update={"order_by": ["id"]}))


def test_normalizes_distributed_identifier_arguments() -> None:
    assert normalize_engine("Distributed(cluster, app, events_local, rand())") == (
        "Distributed('cluster', 'app', 'events_local', rand())"
    )
    assert normalize_engine("Distributed('cluster', `app`, \"events_local\")") == (
        "Distributed('cluster', 'app', 'events_local')"
    )
    assert normalize_engine("Distributed(cluster, currentDatabase(), t, cityHash64(id))") == (
        "Distributed('cluster', currentDatabase(), 't', cityHash64(id))"
    )


# ---------- planner ----------


def test_adds_a_column_to_local_and_distributed_tables_separately() -> None:
    added = [*COLUMNS, {"name": "country", "type": "String"}]
    before = canonicalize_definitions([local(), distributed()])
    after = canonicalize_definitions([local(added), distributed(columns=added)])
    # Codepoint key order (TS uses localeCompare and lists events_local first;
    # see DRIFT.md, plan-pipeline sort).
    assert [(op.risk, op.sql) for op in plan_diff(before, after).operations] == [
        ("safe", "ALTER TABLE app.events ADD COLUMN IF NOT EXISTS `country` String;"),
        ("safe", "ALTER TABLE app.events_local ADD COLUMN IF NOT EXISTS `country` String;"),
    ]


def test_recreates_distributed_at_caution_risk() -> None:
    before = canonicalize_definitions([distributed()])
    after = canonicalize_definitions(
        [distributed("Distributed(cluster, app, events_local, cityHash64(id))")]
    )
    assert [(op.type, op.risk) for op in plan_diff(before, after).operations] == [
        ("drop_table", "caution"),
        ("create_table", "safe"),
    ]


def test_recreate_stays_dangerous_when_flush_on_detach_is_off() -> None:
    settings: dict[str, str | int | float | bool] = {"flush_on_detach": 0}
    before = canonicalize_definitions([distributed(settings=settings)])
    after = canonicalize_definitions(
        [distributed("Distributed(cluster, app, events_local, cityHash64(id))", settings=settings)]
    )
    assert [(op.type, op.risk) for op in plan_diff(before, after).operations] == [
        ("drop_table", "danger"),
        ("create_table", "safe"),
    ]


def test_identifier_quoting_alone_plans_nothing() -> None:
    before = canonicalize_definitions([distributed()])
    after = canonicalize_definitions(
        [distributed("Distributed('cluster', 'app', 'events_local', rand())")]
    )
    assert plan_diff(before, after).operations == []


# ---------- pull ----------


def test_pull_renders_distributed_without_keys() -> None:
    content = render_schema_file(
        [distributed("Distributed('cluster', 'app', 'events_local', rand())")]
    )
    assert "engine=\"Distributed('cluster', 'app', 'events_local', rand())\"" in content
    assert "primary_key" not in content
    assert "order_by" not in content


# ---------- obsessiondb plugin ----------


def _config(url: str, schema: str = "./schema.py") -> ChxResolvedConfig:
    return ChxResolvedConfig(
        schema_=[schema],
        out_dir="./chkit",
        migrations_dir="./chkit/migrations",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
        clickhouse=ChxResolvedClickHouseConfig(
            url=url, username="default", password="", database="default", secure=False
        ),
    )


def _schema_loaded(url: str, flags: dict[str, bool] | None = None) -> list[object]:
    runtime = load_plugin_runtime([obsessiondb()])
    return list(
        runtime.run_on_schema_loaded(
            ChxOnSchemaLoadedContext(
                command="generate",
                config=_config(url),
                table_scope=TableScope(enabled=False),
                flags=dict(flags or {}),
                definitions=[distributed()],
                json_mode=True,
            )
        )
    )


def test_obsessiondb_plugin_rejects_distributed_on_obsessiondb() -> None:
    with pytest.raises(Exception, match="uses the Distributed engine, which ObsessionDB"):
        _schema_loaded("https://x.obsessiondb.com")
    with pytest.raises(Exception, match="uses the Distributed engine, which ObsessionDB"):
        _schema_loaded("http://localhost:8123", {"--force-shared-engines": True})


def test_obsessiondb_plugin_keeps_distributed_for_regular_clickhouse() -> None:
    assert [d.engine for d in _schema_loaded("http://localhost:8123")] == [  # type: ignore[attr-defined]
        "Distributed(cluster, app, events_local, rand())"
    ]


def test_obsessiondb_on_check_reports_distributed_tables(tmp_path: Path) -> None:
    (tmp_path / "schema.py").write_text(
        "from chkit import table\n\n"
        "events = table(database='app', name='events', "
        "engine='Distributed(cluster, app, events_local, rand())', "
        "columns=[{'name': 'id', 'type': 'UInt64'}])\n"
    )
    hooks = obsessiondb().hooks

    def check(url: str) -> object:
        return hooks.on_check(  # type: ignore[union-attr]
            ChxOnCheckContext(
                command="check",
                config=_config(url, "schema.py"),
                table_scope=TableScope(enabled=False),
                flags={},
                config_path=str(tmp_path / "clickhouse.config.py"),
            )
        )

    result = check("https://x.obsessiondb.com")
    assert result.ok is False  # type: ignore[attr-defined]
    assert [(f.code, f.message) for f in result.findings] == [  # type: ignore[attr-defined]
        ("obsessiondb_distributed_unsupported", DISTRIBUTED_MESSAGE)
    ]
    assert check("http://localhost:8123") is None
