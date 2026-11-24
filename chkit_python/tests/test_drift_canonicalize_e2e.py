"""Drift compares SQL expressions in ClickHouse's canonical form (#195), live.

ClickHouse stores `cityHash64(a,b)` as `cityHash64(a, b)` and
`INTERVAL 5 YEAR` as `toIntervalYear(5)`; a schema written the other way must
not report drift once the table exists.
"""

from __future__ import annotations

from pathlib import Path

from chkit.cli.commands.drift_compare import compare_table_shape
from chkit.cli.commands.drift_payload import build_drift_payload
from chkit.clickhouse.canonicalize import canonicalize_sql_fragments
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_table, wait_for_view
from chkit.clickhouse.introspect import list_schema_objects, list_table_details
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import (
    ChxResolvedClickHouseConfig,
    SkipIndexMinmax,
    TableDefinition,
    table,
    view,
)
from chkit.core.snapshot import create_snapshot
from chkit.core.sql import to_create_sql
from tests.e2e_testkit import create_prefix, poll_until, resolve_live_env


def _connect() -> ClickHouseClient:
    env = resolve_live_env()
    return ClickHouseClient.connect(
        ChxResolvedClickHouseConfig(
            url=env.clickhouse_url,
            username=env.clickhouse_user,
            password=env.clickhouse_password,
            database=env.clickhouse_database,
            secure=env.clickhouse_url.startswith("https:"),
        )
    )


def test_canonicalize_sql_fragments_uses_clickhouse_formatting() -> None:
    with _connect() as client:
        expressions = canonicalize_sql_fragments(
            client, ["cityHash64(a,b)", "ts + INTERVAL 5 YEAR", "((bad"], wrap=True
        )
        queries = canonicalize_sql_fragments(client, ["SELECT a,count() GROUP BY a"], wrap=False)

    assert expressions["cityHash64(a,b)"] == "cityHash64(a, b)"
    assert expressions["ts + INTERVAL 5 YEAR"] == "ts + toIntervalYear(5)"
    assert "((bad" not in expressions
    assert queries["SELECT a,count() GROUP BY a"] == "SELECT a, count() GROUP BY a"


def test_canonicalize_keeps_a_select_modifier_name_in_the_expression() -> None:
    with _connect() as client:
        expressions = canonicalize_sql_fragments(
            client,
            [
                "all + id",
                "distinct + id",
                "id",
                "`all` + id",
                "cityHash64(a,b)",
                "ts + INTERVAL 5 YEAR",
                "ts + INTERVAL 1 DAY DELETE",
            ],
            wrap=True,
        )

    # Read as `SELECT all + id`, the server would take `all` as the modifier.
    assert expressions["all + id"] == "`all` + id"
    assert expressions["all + id"] == expressions["`all` + id"]
    assert expressions["all + id"] != expressions["id"]
    assert expressions["distinct + id"] == "`distinct` + id"
    assert expressions["cityHash64(a,b)"] == "cityHash64(a, b)"
    assert expressions["ts + INTERVAL 5 YEAR"] == "ts + toIntervalYear(5)"
    # A TTL element with an action does not parse in parentheses; it formats as before.
    assert expressions["ts + INTERVAL 1 DAY DELETE"] == "ts + toIntervalDay(1) AS DELETE"


def test_expressions_spelled_differently_from_clickhouse_report_no_drift(tmp_path: Path) -> None:
    with _connect() as client:
        database = client.database
        name = create_prefix("drift_canonical") + "events"
        definition = table(
            database=database,
            name=name,
            engine="MergeTree()",
            columns=[
                {"name": "a", "type": "String"},
                {"name": "b", "type": "String"},
                {"name": "ts", "type": "DateTime"},
            ],
            primary_key=["a"],
            order_by=["a", "cityHash64(a,b)"],
            partition_by="toYYYYMM(ts)",
            ttl="ts + INTERVAL 5 YEAR",
            indexes=[SkipIndexMinmax(name="i", expression="cityHash64(a,b)", granularity=1)],
        )
        snapshot = create_snapshot(canonicalize_definitions([definition]))
        try:
            client.execute(to_create_sql(definition))
            wait_for_table(client, database, name)

            def observe() -> tuple[list[str], list[str]]:
                payload = build_drift_payload(
                    client=client, meta_dir=tmp_path, snapshot=snapshot, database=database
                )
                return (
                    [key for key in payload.missing if name in key],
                    [detail.table for detail in payload.table_drift if name in detail.table],
                )

            # Each read may land on a replica that has not applied the CREATE yet.
            missing, drifted = poll_until(observe, lambda seen: seen == ([], []))
            assert (missing, drifted) == ([], [])

            # Plain string comparison alone still sees the spelling difference.
            actual = poll_until(
                lambda: next(
                    (t for t in list_table_details(client, [database]) if t.name == name), None
                ),
                lambda found: found is not None,
            )
            assert actual is not None
            expected = snapshot.definitions[0]
            assert isinstance(expected, TableDefinition)
            detail = compare_table_shape(expected, actual)
            assert detail is not None
            assert "index_mismatch" in detail.reason_codes
        finally:
            client.execute(f"DROP TABLE IF EXISTS {database}.{name} SYNC")


def test_column_expressions_read_clean_as_clickhouse_formats_them(tmp_path: Path) -> None:
    """A DEFAULT, MATERIALIZED or ALIAS expression is compared in ClickHouse's
    canonical form (#752), and a changed one still drifts."""
    with _connect() as client:
        database = client.database
        name = create_prefix("drift_col_expr") + "users"
        # ClickHouse stores these as `(id * 2) + 1`, `ts + toIntervalDay(1)`,
        # `floor(id)` and `lower(s)`.
        definition = table(
            database=database,
            name=name,
            engine="MergeTree()",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "ts", "type": "DateTime"},
                {"name": "s", "type": "String"},
                {"name": "bucket", "type": "UInt64", "default": {"expression": "FLOOR(id)"}},
                {
                    "name": "lowered",
                    "type": "String",
                    "defaultKind": "MATERIALIZED",
                    "default": {"expression": "LCASE(s)"},
                },
                {"name": "score", "type": "UInt64", "default": {"expression": "id * 2 + 1"}},
                {
                    "name": "due",
                    "type": "DateTime",
                    "defaultKind": "MATERIALIZED",
                    "default": {"expression": "ts + INTERVAL 1 DAY"},
                },
                {
                    "name": "twice",
                    "type": "UInt64",
                    "defaultKind": "ALIAS",
                    "default": {"expression": "id * 2 + 1"},
                },
            ],
            order_by=["id"],
        )
        snapshot = create_snapshot(canonicalize_definitions([definition]))
        try:
            client.execute(to_create_sql(definition))
            wait_for_table(client, database, name)

            def observe() -> tuple[list[str], list[str]]:
                payload = build_drift_payload(
                    client=client, meta_dir=tmp_path, snapshot=snapshot, database=database
                )
                return (
                    [key for key in payload.missing if name in key],
                    sorted(
                        column
                        for detail in payload.table_drift
                        if name in detail.table
                        for column in detail.changed_columns
                    ),
                )

            # Each read may land on a replica that has not applied the CREATE yet.
            assert poll_until(observe, lambda seen: seen == ([], [])) == ([], [])

            client.execute(
                f"ALTER TABLE {database}.{name} MODIFY COLUMN score UInt64 DEFAULT id * 3 + 1"
            )
            assert poll_until(observe, lambda seen: seen == ([], ["score"])) == ([], ["score"])
        finally:
            client.execute(f"DROP TABLE IF EXISTS {database}.{name} SYNC")


_CLAUSE_KEYWORDS = [
    "from",
    "where",
    "group",
    "order",
    "limit",
    "settings",
    "format",
    "union",
    "except",
    "intersect",
    "having",
    "with",
]


def test_canonicalize_formats_a_clause_keyword_name_as_a_bare_select_does() -> None:
    fragments = [*_CLAUSE_KEYWORDS, *(f"lower({keyword})" for keyword in _CLAUSE_KEYWORDS)]
    with _connect() as client:
        expressions = canonicalize_sql_fragments(client, fragments, wrap=True)
        bare: dict[str, str | None] = {}
        for fragment in fragments:
            rows = client.query(
                f"SELECT formatQuerySingleLineOrNull('SELECT ' || '{fragment}') AS formatted"
            ).rows
            formatted = rows[0]["formatted"]
            bare[fragment] = None if formatted is None else formatted.removeprefix("SELECT ")

    # `SELECT 0, from` does not parse, so `from` is formatted on its own.
    for fragment in fragments:
        assert (fragment, expressions.get(fragment)) == (fragment, bare[fragment])
    assert "from" in expressions


def test_canonicalize_does_not_retry_a_fragment_led_by_all_or_distinct() -> None:
    with _connect() as client:
        expressions = canonicalize_sql_fragments(
            client, ["all from", "ALL from", "distinct from", "from"], wrap=True
        )

    # `SELECT all from` would format as `SELECT from`, matching a live `from`.
    assert "from" in expressions
    for fragment in ["all from", "ALL from", "distinct from"]:
        assert (fragment, expressions.get(fragment)) == (fragment, None)


def test_columns_named_from_and_all_read_clean_and_a_changed_default_drifts(
    tmp_path: Path,
) -> None:
    with _connect() as client:
        database = client.database
        name = create_prefix("drift_kw_names") + "users"
        # `from` does not format after `SELECT 0,`, and `all` reads as the
        # modifier right after `SELECT`.
        definition = table(
            database=database,
            name=name,
            engine="MergeTree()",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "from", "type": "DateTime"},
                {"name": "all", "type": "UInt64"},
                {"name": "score", "type": "UInt64", "default": {"expression": "all + id"}},
            ],
            order_by=["id"],
            indexes=[SkipIndexMinmax(name="idx_from", expression="from", granularity=1)],
            ttl="from",
        )
        snapshot = create_snapshot(canonicalize_definitions([definition]))
        try:
            client.execute(to_create_sql(definition))
            wait_for_table(client, database, name)

            def observe() -> tuple[list[str], list[str]]:
                payload = build_drift_payload(
                    client=client, meta_dir=tmp_path, snapshot=snapshot, database=database
                )
                return (
                    [key for key in payload.missing if name in key],
                    sorted(
                        code
                        for detail in payload.table_drift
                        if name in detail.table
                        for code in [*detail.reason_codes, *detail.changed_columns]
                    ),
                )

            # Each read may land on a replica that has not applied the CREATE yet.
            assert poll_until(observe, lambda seen: seen == ([], [])) == ([], [])

            client.execute(f"ALTER TABLE {database}.{name} MODIFY COLUMN score UInt64 DEFAULT id")
            expected: tuple[list[str], list[str]] = ([], ["changed_column", "score"])
            assert poll_until(observe, lambda seen: seen == expected) == expected
        finally:
            client.execute(f"DROP TABLE IF EXISTS {database}.{name} SYNC")


def test_view_query_function_case_and_aliases_report_no_drift(tmp_path: Path) -> None:
    """FLOOR/CEILING in a schema view must not drift against the stored query (#731).

    ClickHouse stores `FLOOR(amount)` as `floor(amount)` and the alias
    `CEILING(amount)` as `ceil(amount)`, while case-sensitive names such as
    `toUnixTimestamp` are stored as written. Drift must converge the registered
    spellings without touching case-sensitive names.
    """
    with _connect() as client:
        database = client.database
        prefix = create_prefix("drift_fn_case")
        events = f"{prefix}events"
        report = f"{prefix}report"
        events_def = table(
            database=database,
            name=events,
            engine="MergeTree()",
            columns=[
                {"name": "id", "type": "UInt64"},
                {"name": "amount", "type": "Float64"},
            ],
            primary_key=["id"],
            order_by=["id"],
        )
        report_def = view(
            database=database,
            name=report,
            as_=(
                "SELECT FLOOR(amount) AS floored, CEILING(amount) AS ceiled, "
                f"toUnixTimestamp(now64()) AS ts FROM {events}"
            ),
        )
        snapshot = create_snapshot(canonicalize_definitions([events_def, report_def]))
        try:
            client.execute(to_create_sql(events_def))
            wait_for_table(client, database, events)
            client.execute(to_create_sql(report_def))
            wait_for_view(client, database, report)

            def observe() -> tuple[list[str], list[str], list[str]]:
                payload = build_drift_payload(
                    client=client, meta_dir=tmp_path, snapshot=snapshot, database=database
                )
                return (
                    [key for key in payload.missing if events in key or report in key],
                    [detail.table for detail in payload.table_drift if events in detail.table],
                    [
                        f"{detail.code} {detail.object}"
                        for detail in payload.object_drift
                        if report in detail.object and detail.code != "extra_object"
                    ],
                )

            # Each read may land on a replica that has not applied the CREATE yet.
            missing, drifted, view_drift = poll_until(observe, lambda seen: seen == ([], [], []))
            assert (missing, drifted, view_drift) == ([], [], [])
        finally:
            client.execute(f"DROP VIEW IF EXISTS {database}.{report} SYNC")
            client.execute(f"DROP TABLE IF EXISTS {database}.{events} SYNC")


def test_refresh_backing_catalog_filter_requires_same_database_owner() -> None:
    with _connect() as client:
        database = create_prefix("refresh_objects")
        try:
            client.execute(f"CREATE DATABASE {database}")
            client.execute(
                f"CREATE MATERIALIZED VIEW {database}.mv REFRESH AFTER 1 DAY "
                "ENGINE=MergeTree ORDER BY id EMPTY AS "
                "SELECT number AS id FROM numbers(3)"
            )
            uuid = client.query(
                "SELECT toString(uuid) AS uuid FROM system.tables "
                f"WHERE database='{database}' AND name='mv'"
            ).rows[0]["uuid"]
            inner, temporary = f".inner_id.{uuid}", f".tmp.inner_id.{uuid}"
            client.execute(f"SYSTEM STOP VIEW {database}.mv")
            client.execute(
                f"CREATE TABLE IF NOT EXISTS {database}.`{temporary}` (id UInt64) ENGINE=Memory"
            )
            orphan = ".tmp.inner_id.00000000-0000-0000-0000-000000000001"
            lookalike = temporary + "_user"
            for name in (orphan, lookalike):
                client.execute(f"CREATE TABLE {database}.`{name}` (id UInt64) ENGINE=Memory")
            raw = client.query(f"SELECT name FROM system.tables WHERE database='{database}'").rows
            assert {inner, temporary} <= {row["name"] for row in raw}
            objects = [obj.name for obj in list_schema_objects(client) if obj.database == database]
            assert sorted(objects) == sorted([orphan, lookalike, "mv"])
        finally:
            client.execute(f"DROP DATABASE IF EXISTS {database} SYNC")


def test_shared_udf_queries_retain_literals_independently_of_pair_order() -> None:
    with _connect() as client:
        name = create_prefix("shared_udf")
        body = (
            "CAST(tuple(if(length(text) + length(toString(categories)) >= 0, "
            "'unknown', 'unknown'), toFloat64(0)), 'Tuple(category String, confidence Float64)')"
        )
        try:
            client.execute(f"CREATE FUNCTION {name} AS (text, categories) -> {body}")
            original = f"SELECT {name}('original input', map('lead', 'original prompt')) AS verdict"
            changed = original.replace("original prompt", "changed prompt")
            stored_body = body.replace("length(text)", "length('original input')").replace(
                "toString(categories)", "toString(map('lead', 'original prompt'))"
            )
            stored = f"SELECT {stored_body} AS verdict"
            for pairs in (
                [(original, stored), (changed, stored)],
                [(changed, stored), (original, stored)],
            ):
                result = canonicalize_sql_fragments(
                    client, [original, stored, changed], wrap=False, stored_query_pairs=pairs
                )
                assert result[original] == result[stored]
                assert result[changed] != result[stored]
        finally:
            client.execute(f"DROP FUNCTION IF EXISTS {name}")


def test_sql_udf_storage_preserves_arithmetic_and_body_drift() -> None:
    with _connect() as client:
        name = create_prefix("udf_storage")
        view_name = name + "view"
        database = client.database
        query = f"SELECT {name}(number + 2, number * 2) AS value FROM numbers(3)"
        try:
            client.execute(f"CREATE FUNCTION {name} AS (x, y) -> x - y")
            client.execute(f"CREATE VIEW {database}.{view_name} AS {query}")

            def observe() -> tuple[str, str, str]:
                stored = str(client.query(
                    "SELECT as_select FROM system.tables "
                    f"WHERE database='{database}' AND name='{view_name}'"
                ).rows[0]["as_select"])
                result = canonicalize_sql_fragments(
                    client, [query, stored], wrap=False, stored_query_pairs=[(query, stored)]
                )
                return stored, result[query], result[stored]

            stored, expected, actual = poll_until(observe, lambda value: value[1] == value[2])
            assert name + "(" not in stored
            assert expected == actual
            client.execute(f"CREATE OR REPLACE FUNCTION {name} AS (x, y) -> x + y")

            def changed() -> dict[str, str]:
                return canonicalize_sql_fragments(
                    client, [query, stored], wrap=False, stored_query_pairs=[(query, stored)]
                )

            result = poll_until(changed, lambda value: value[query] != value[stored])
            assert result[query] != result[stored]
        finally:
            client.execute(f"DROP VIEW IF EXISTS {database}.{view_name}")
            client.execute(f"DROP FUNCTION IF EXISTS {name}")
