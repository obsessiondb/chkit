"""Kafka DSL, SQL, parser, pull and migration-safety parity with TypeScript."""

from dataclasses import replace

import pytest

from chkit import materialized_view, table
from chkit.cli.commands.drift_compare import compare_table_shape
from chkit.cli.commands.pull import _introspected_table_to_definition
from chkit.cli.commands.pull_render import render_schema_file
from chkit.cli.commands.snapshot_drift import plan_snapshot_drift
from chkit.cli.table_scope import resolve_table_scope
from chkit.clickhouse.create_table_parser import (
    parse_engine_from_create_table_query,
    parse_settings_from_create_table_query,
)
from chkit.clickhouse.introspect import IntrospectedTable
from chkit.core.kafka import parse_kafka_setting, render_kafka_setting
from chkit.core.model import ChxValidationError
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from chkit.core.sql_normalizer import normalize_engine
from chkit.core.sql_splitter import extract_executable_statements
from chkit.core.validate import validate_definitions


def queue():
    return table(
        database="app",
        name="queue",
        engine="Kafka",
        columns=[{"name": "id", "type": "String"}],
        settings={
            "kafka_broker_list": "a:9092,b:9092",
            "kafka_topic_list": "events",
            "kafka_group_name": "consumer",
            "kafka_format": "JSONEachRow",
            "kafka_num_consumers": 1,
            "kafka_commit_on_select": False,
        },
    )


def test_queue_sql_and_validation():
    sql = to_create_sql(queue())
    assert "PRIMARY KEY" not in sql
    assert "ORDER BY" not in sql
    assert "kafka_broker_list = 'a:9092,b:9092'" in sql
    assert "kafka_commit_on_select = 0" in sql
    assert validate_definitions([queue()]) == []
    bad = queue().model_copy(update={"primary_key": ["id"], "ttl": "id"})
    assert [issue.code for issue in validate_definitions([bad])] == [
        "kafka_unsupported_clause",
        "kafka_unsupported_clause",
    ]
    assert len(validate_definitions([queue().model_copy(update={"settings": {}})])) == 4
    default = queue().columns[0].model_copy(update={"default": ""})
    assert (
        validate_definitions([queue().model_copy(update={"columns": [default]})])[0].code
        == "kafka_column_default"
    )
    with pytest.raises(ValueError, match="requires primary_key"):
        table(database="app", name="stored", engine="MergeTree", columns=[])


@pytest.mark.parametrize(
    "value", ["a'b", "a\\b\\", "a; SETTINGS COMMENT", "a\nb\tc", "'quoted'", "é"]
)
def test_literal_round_trip(value):
    assert parse_kafka_setting(render_kafka_setting(value)) == value


def test_hex_control_and_unknown_escapes():
    assert parse_kafka_setting(r"'\xC3\xA9\a\v\N\q\%'") == "é\a\v\\q\\%"


def test_parser_pull_and_drift():
    original = queue()
    sql = to_create_sql(original)
    settings = parse_settings_from_create_table_query(sql)
    actual = IntrospectedTable(
        database="app",
        name="queue",
        engine="Kafka()",
        columns=original.columns,
        settings=settings,
        indexes=[],
        projections=[],
    )
    assert compare_table_shape(original, actual) is None
    pulled = _introspected_table_to_definition(actual)
    assert pulled is not None
    assert plan_diff([original], [pulled]).operations == []
    source = render_schema_file([pulled])
    assert "primary_key=" not in source
    assert "order_by=" not in source
    assert "'a:9092,b:9092'" in source or '"a:9092,b:9092"' in source
    changed = replace(actual, settings={**settings, "kafka_group_name": "'different'"})
    drift = compare_table_shape(original, changed)
    assert drift is not None
    assert drift.setting_diffs == ["kafka_group_name"]


def test_quoted_delimiters_and_engine_arguments():
    engine = "Kafka('host:9092', 'SETTINGS; COMMENT', 'a  b', 'JSONEachRow')"
    sql = f"CREATE TABLE q (id String) ENGINE = {engine} SETTINGS kafka_client_id = 'a;\\\\';"
    assert parse_engine_from_create_table_query(sql) == engine
    assert (
        parse_kafka_setting(parse_settings_from_create_table_query(sql)["kafka_client_id"])
        == "a;\\"
    )
    assert len(extract_executable_statements(sql + "\nSELECT 1;")) == 2
    assert (
        normalize_engine("Kafka( 'b', 'a  b', 'c', 'JSONEachRow' )")
        == "Kafka('b', 'a  b', 'c', 'JSONEachRow')"
    )


def test_rejects_unsupported_changes_and_drops_synchronously():
    original = queue()
    for changed in [
        original.model_copy(
            update={"settings": {**(original.settings or {}), "kafka_num_consumers": 2}}
        ),
        original.model_copy(
            update={"columns": [original.columns[0].model_copy(update={"name": "renamed"})]}
        ),
        original.model_copy(
            update={"engine": "MergeTree", "primary_key": ["id"], "order_by": ["id"]}
        ),
    ]:
        with pytest.raises(ChxValidationError) as error:
            plan_diff([original], [changed])
        assert error.value.issues[0].code == "kafka_change_requires_replacement"
    mv = materialized_view(
        database="app",
        name="mv",
        to={"database": "app", "name": "stored"},
        as_="SELECT id FROM app.queue",
    )
    drops = plan_diff([original, mv], []).operations
    assert [op.type for op in drops] == ["drop_materialized_view", "drop_table"]
    assert drops[1].sql == "DROP TABLE IF EXISTS app.queue SYNC;"


def test_snapshot_checks_report_replacements_and_keep_other_scoped_changes():
    original = queue()
    changed = original.model_copy(update={"comment": "changed"})
    stored = table(
        database="app",
        name="stored",
        engine="MergeTree",
        columns=list(original.columns),
        primary_key=["id"],
        order_by=["id"],
    )
    edited = stored.model_copy(update={"settings": {"index_granularity": 4096}})
    for selector, expected_issues, expected_operations in [
        (None, 1, 1),
        ("queue", 1, 0),
        ("stored", 0, 1),
        ("missing", 0, 0),
    ]:
        scope = resolve_table_scope(selector, ["app.queue", "app.stored"])
        plan, issues = plan_snapshot_drift([original, stored], [changed, edited], scope)
        assert len(issues) == expected_issues
        assert len(plan.operations) == expected_operations
        assert all("app.queue" not in operation.key for operation in plan.operations)
