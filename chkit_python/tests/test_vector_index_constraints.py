"""vector_similarity / raw skip indexes and table constraints (#278), TS parity."""

from __future__ import annotations

from typing import Any

import pytest

from chkit import SkipIndexRaw, SkipIndexVectorSimilarity, TableConstraintDefinition, table
from chkit.cli.commands.drift_compare import (
    MapSqlCanonicalizer,
    collect_table_sql_fragments,
    compare_table_shape,
)
from chkit.cli.commands.pull_render import render_schema_file
from chkit.clickhouse.create_table_parser import parse_constraints_from_create_table_query
from chkit.clickhouse.introspect import (
    IntrospectedTable,
    SystemSkippingIndexRow,
    normalize_index_from_system_row,
)
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import ChxValidationError, ColumnDefinition, TableDefinition
from chkit.core.on_cluster import apply_on_cluster_to_plan
from chkit.core.planner import plan_diff
from chkit.core.sql import to_create_sql
from chkit.core.validate import validate_definitions

HNSW: dict[str, Any] = {
    "name": "embedding_hnsw",
    "expression": "embedding",
    "type": "vector_similarity",
    "method": "hnsw",
    "distanceFunction": "cosineDistance",
    "dimensions": 512,
}
DIMENSION = {"name": "dimension", "check": "length(embedding) = 512"}
POSITIVE = {"name": "positive-id", "assume": "id > 0"}


def vectors(**overrides: Any) -> TableDefinition:
    args: dict[str, Any] = {
        "database": "app",
        "name": "vectors",
        "columns": [{"name": "id", "type": "UInt64"}, {"name": "embedding", "type": "Array(Float32)"}],
        "engine": "MergeTree()",
        "primaryKey": ["id"],
        "orderBy": ["id"],
        **overrides,
    }
    return table(**args)


def codes(definition: TableDefinition) -> list[str]:
    return [issue.code for issue in validate_definitions([definition])]


# ---------- vector_similarity ----------


def test_renders_three_argument_form_with_default_granularity() -> None:
    sql = to_create_sql(vectors(indexes=[HNSW]))
    assert (
        "INDEX `embedding_hnsw` (embedding) TYPE vector_similarity('hnsw', 'cosineDistance', 512) "
        "GRANULARITY 100000000" in sql
    )


def test_renders_tuning_and_explicit_granularity() -> None:
    index = {
        **HNSW,
        "distanceFunction": "L2Distance",
        "dimensions": 4,
        "quantization": "bf16",
        "hnswMaxConnectionsPerLayer": 32,
        "hnswCandidateListSizeForConstruction": 128,
        "granularity": 1000,
    }
    sql = to_create_sql(vectors(indexes=[index]))
    assert "TYPE vector_similarity('hnsw', 'L2Distance', 4, 'bf16', 32, 128) GRANULARITY 1000" in sql


def test_omits_dimensions_for_servers_older_than_25_4() -> None:
    index = {k: v for k, v in HNSW.items() if k != "dimensions"}
    index |= {"quantization": "f32", "hnswMaxConnectionsPerLayer": 16,
              "hnswCandidateListSizeForConstruction": 64}
    sql = to_create_sql(vectors(indexes=[index]))
    assert "TYPE vector_similarity('hnsw', 'cosineDistance', 'f32', 16, 64)" in sql


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"distanceFunction": "innerProduct"}, "distanceFunction must be one of"),
        ({"method": "ivf"}, "method must be one of hnsw"),
        ({"dimensions": 0}, "dimensions must be a positive integer"),
        ({"quantization": "bf16"}, "set all three or none"),
        ({"quantization": "f8", "hnswMaxConnectionsPerLayer": 16,
          "hnswCandidateListSizeForConstruction": 64}, "quantization must be one of"),
        ({"quantization": "f32", "hnswMaxConnectionsPerLayer": 1,
          "hnswCandidateListSizeForConstruction": 64}, "at least 2"),
        ({"distanceFunction": "L2Distance", "quantization": "b1", "hnswMaxConnectionsPerLayer": 16,
          "hnswCandidateListSizeForConstruction": 64}, "requires distanceFunction 'cosineDistance'"),
        ({"dimensions": 12, "quantization": "b1", "hnswMaxConnectionsPerLayer": 16,
          "hnswCandidateListSizeForConstruction": 64}, "multiple of 8"),
        ({"granularity": 0}, "granularity must be a positive integer"),
    ],
)
def test_rejects_invalid_vector_arguments(override: dict[str, Any], message: str) -> None:
    issues = validate_definitions([vectors(indexes=[{**HNSW, **override}])])
    assert [issue.code for issue in issues] == ["vector_index_invalid_parameters"]
    assert message in issues[0].message


def test_changed_vector_index_is_dropped_and_re_added() -> None:
    plan = plan_diff(
        [vectors(indexes=[HNSW])], [vectors(indexes=[{**HNSW, "distanceFunction": "L2Distance"}])]
    )
    assert [(op.type, op.risk) for op in plan.operations] == [
        ("alter_table_drop_index", "caution"),
        ("alter_table_add_index", "caution"),
    ]
    assert plan.operations[1].sql == (
        "ALTER TABLE app.vectors ADD INDEX IF NOT EXISTS `embedding_hnsw` (embedding) TYPE "
        "vector_similarity('hnsw', 'L2Distance', 512) GRANULARITY 100000000;"
    )


def test_omitted_granularity_equals_explicit_default() -> None:
    plan = plan_diff(
        [vectors(indexes=[HNSW])], [vectors(indexes=[{**HNSW, "granularity": 100_000_000}])]
    )
    assert plan.operations == []


# ---------- raw ----------


def test_raw_index_renders_verbatim_and_needs_a_type() -> None:
    raw = {"name": "sg", "expression": "id", "type": "raw",
           "rawType": "sparse_grams(3, 20, 256, 2, 0)", "granularity": 1}
    assert "INDEX `sg` (id) TYPE sparse_grams(3, 20, 256, 2, 0) GRANULARITY 1" in to_create_sql(
        vectors(indexes=[raw])
    )
    assert codes(vectors(indexes=[{**raw, "rawType": "  "}])) == ["raw_index_invalid_type"]


# ---------- constraints ----------


def test_constraints_render_in_create_table_after_indexes() -> None:
    sql = to_create_sql(vectors(indexes=[HNSW], constraints=[DIMENSION, POSITIVE]))
    assert (
        "GRANULARITY 100000000,\n  CONSTRAINT `dimension` CHECK length(embedding) = 512,\n"
        "  CONSTRAINT `positive-id` ASSUME id > 0\n)" in sql
    )


def test_adding_constraints_is_caution_with_warning() -> None:
    plan = plan_diff([vectors()], [vectors(constraints=[DIMENSION, POSITIVE])])
    assert [(op.type, op.risk, op.sql) for op in plan.operations] == [
        ("alter_table_add_constraint", "caution",
         "ALTER TABLE app.vectors ADD CONSTRAINT IF NOT EXISTS `dimension` CHECK length(embedding) = 512;"),
        ("alter_table_add_constraint", "caution",
         "ALTER TABLE app.vectors ADD CONSTRAINT IF NOT EXISTS `positive-id` ASSUME id > 0;"),
    ]
    assert "does not validate existing rows" in (plan.operations[0].warning or "")
    assert "never validates it" in (plan.operations[1].warning or "")


def test_changed_constraint_is_dropped_and_re_added_and_removed_one_dropped() -> None:
    plan = plan_diff(
        [vectors(constraints=[DIMENSION, POSITIVE])],
        [vectors(constraints=[{"name": "dimension", "assume": "length(embedding) = 512"}])],
    )
    assert [op.sql for op in plan.operations] == [
        "ALTER TABLE app.vectors DROP CONSTRAINT IF EXISTS `dimension`;",
        "ALTER TABLE app.vectors DROP CONSTRAINT IF EXISTS `positive-id`;",
        "ALTER TABLE app.vectors ADD CONSTRAINT IF NOT EXISTS `dimension` ASSUME length(embedding) = 512;",
    ]


def test_whitespace_and_comments_are_not_a_change() -> None:
    changed = {"name": "dimension", "check": "length(embedding)\n  = 512 -- dims"}
    assert plan_diff([vectors(constraints=[DIMENSION])], [vectors(constraints=[changed])]).operations == []


def test_snapshot_without_constraints_plans_nothing() -> None:
    [legacy] = canonicalize_definitions([vectors()])
    stored = legacy.model_dump(by_alias=True)
    stored.pop("constraints")
    assert plan_diff([TableDefinition.model_validate(stored)], [vectors(constraints=[])]).operations == []


def test_dependent_drops_run_before_the_column_drop() -> None:
    plan = plan_diff(
        [vectors(indexes=[HNSW], constraints=[DIMENSION])],
        [vectors(columns=[{"name": "id", "type": "UInt64"}])],
    )
    assert [op.type for op in plan.operations] == [
        "alter_table_drop_constraint",
        "alter_table_drop_index",
        "alter_table_drop_column",
    ]


def test_constraints_are_added_after_their_column() -> None:
    plan = plan_diff(
        [vectors(columns=[{"name": "id", "type": "UInt64"}])], [vectors(constraints=[DIMENSION])]
    )
    assert [op.type for op in plan.operations] == ["alter_table_add_column", "alter_table_add_constraint"]


def test_constraint_alters_get_on_cluster() -> None:
    plan = apply_on_cluster_to_plan(
        plan_diff([vectors(constraints=[POSITIVE])], [vectors(constraints=[DIMENSION])]),
        "test_cluster_2s",
    )
    assert [op.sql for op in plan.operations] == [
        "ALTER TABLE app.vectors ON CLUSTER 'test_cluster_2s' DROP CONSTRAINT IF EXISTS `positive-id`;",
        "ALTER TABLE app.vectors ON CLUSTER 'test_cluster_2s' ADD CONSTRAINT IF NOT EXISTS "
        "`dimension` CHECK length(embedding) = 512;",
    ]


@pytest.mark.parametrize(
    ("constraints", "code"),
    [
        ([DIMENSION, {"name": "dimension", "check": "id > 0"}], "duplicate_constraint_name"),
        ([{"name": "c", "check": "id > 0", "assume": "id > 0"}], "constraint_invalid"),
        ([{"name": "c"}], "constraint_invalid"),
        ([{"name": "c", "check": " -- nothing"}], "constraint_invalid"),
    ],
)
def test_rejects_invalid_constraints(constraints: list[dict[str, str]], code: str) -> None:
    assert codes(vectors(constraints=constraints)) == [code]


def test_kafka_tables_reject_constraints() -> None:
    definition = table(
        database="app",
        name="queue",
        columns=[{"name": "id", "type": "UInt64"}],
        engine="Kafka",
        settings={"kafka_broker_list": "b:9092", "kafka_topic_list": "t",
                  "kafka_group_name": "g", "kafka_format": "JSONEachRow"},
        constraints=[{"name": "c", "check": "id > 0"}],
    )
    assert codes(definition) == ["kafka_unsupported_clause"]


def test_invalid_definitions_fail_planning() -> None:
    with pytest.raises(ChxValidationError):
        plan_diff([], [vectors(constraints=[{"name": "c"}])])


# ---------- introspection ----------


def _row(type_full: str, granularity: int = 1) -> SystemSkippingIndexRow:
    return SystemSkippingIndexRow(
        database="app", table="vectors", name="idx", expr="embedding", type=type_full,
        granularity=granularity,
    )


@pytest.mark.parametrize(
    ("type_full", "expected"),
    [
        ("vector_similarity('hnsw', 'cosineDistance', 4)",
         {"distance_function": "cosineDistance", "dimensions": 4, "quantization": None}),
        ("vector_similarity('hnsw', 'L2Distance', 4, 'bf16', 32, 128)",
         {"dimensions": 4, "quantization": "bf16", "hnsw_max_connections_per_layer": 32,
          "hnsw_candidate_list_size_for_construction": 128}),
        ("vector_similarity('hnsw', 'L2Distance')", {"dimensions": None, "quantization": None}),
        ("vector_similarity('hnsw', 'cosineDistance', 'f32', 16, 64)",
         {"dimensions": None, "quantization": "f32", "hnsw_max_connections_per_layer": 16}),
    ],
)
def test_reads_structured_vector_index(type_full: str, expected: dict[str, Any]) -> None:
    index = normalize_index_from_system_row(_row(type_full, 100_000_000))
    assert isinstance(index, SkipIndexVectorSimilarity)
    assert index.granularity == 100_000_000
    for field, value in expected.items():
        assert getattr(index, field) == value


@pytest.mark.parametrize(
    "type_full",
    [
        "sparse_grams(3, 100, 512, 1, 3, 0)",
        "vector_similarity('hnsw', 'someFutureDistance', 4)",
        "vector_similarity('hnsw', 'L2Distance', 4, 'bf16')",
        "text(tokenizer = 'splitByNonAlpha', some_future_parameter = 1)",
        "hypothesis",
    ],
)
def test_keeps_unexpressible_types_raw(type_full: str) -> None:
    index = normalize_index_from_system_row(_row(type_full))
    assert index == SkipIndexRaw(name="idx", expression="embedding", granularity=1, raw_type=type_full)


def test_parses_constraints_as_clickhouse_stores_them() -> None:
    query = (
        "CREATE TABLE app.vectors (`id` UInt64, `embedding` Array(Float32), `s` String, "
        "INDEX e embedding TYPE vector_similarity('hnsw', 'cosineDistance', 4) GRANULARITY 100000000, "
        "CONSTRAINT dimension CHECK length(embedding) = 4, CONSTRAINT `a-b` ASSUME id > 0, "
        "CONSTRAINT c3 CHECK (s IN ('a', 'b')) AND (((id + 1) * 2) > 0)) "
        "ENGINE = MergeTree ORDER BY id SETTINGS index_granularity = 8192"
    )
    assert parse_constraints_from_create_table_query(query) == [
        TableConstraintDefinition(name="dimension", check="length(embedding) = 4"),
        TableConstraintDefinition(name="a-b", assume="id > 0"),
        TableConstraintDefinition(name="c3", check="(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)"),
    ]
    assert parse_constraints_from_create_table_query(
        "CREATE TABLE app.t\n(\n    `id` UInt64,\n    CONSTRAINT c CHECK id > 0\n)\nENGINE = MergeTree\nORDER BY id"
    ) == [TableConstraintDefinition(name="c", check="id > 0")]
    assert parse_constraints_from_create_table_query(None) == []


# ---------- drift ----------

CANONICALIZER = MapSqlCanonicalizer(
    expressions={
        "s IN ('a','b') AND (id+1)*2 > 0": "(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)",
        "sparse_grams(3,20, 256,2,0)": "sparse_grams(3, 20, 256, 2, 0)",
    },
    queries={},
)
VECTOR4 = {**HNSW, "name": "e", "dimensions": 4}
RAW_SPARSE = {"name": "sg", "expression": "s", "type": "raw",
              "rawType": "sparse_grams(3,20, 256,2,0)", "granularity": 1}


def _expected(**overrides: Any) -> TableDefinition:
    args: dict[str, Any] = {
        "columns": [{"name": "id", "type": "UInt64"}, {"name": "s", "type": "String"},
                    {"name": "embedding", "type": "Array(Float32)"}],
        "indexes": [VECTOR4, RAW_SPARSE],
        "constraints": [{"name": "dimension", "check": "length(embedding) = 4"},
                        {"name": "c3", "check": "s IN ('a','b') AND (id+1)*2 > 0"}],
        **overrides,
    }
    return vectors(**args)


LIVE_DIMENSION = TableConstraintDefinition(name="dimension", check="length(embedding) = 4")
LIVE_C3 = TableConstraintDefinition(name="c3", check="(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)")


def _actual(
    indexes: list[Any] | None = None, constraints: list[TableConstraintDefinition] | None = None
) -> IntrospectedTable:
    return IntrospectedTable(
        database="app",
        name="vectors",
        columns=[ColumnDefinition(name="id", type="UInt64"), ColumnDefinition(name="s", type="String"),
                 ColumnDefinition(name="embedding", type="Array(Float32)")],
        settings={},
        indexes=indexes if indexes is not None else [
            SkipIndexVectorSimilarity.model_validate({**VECTOR4, "granularity": 100_000_000}),
            SkipIndexRaw(name="sg", expression="s", granularity=1,
                         raw_type="sparse_grams(3, 20, 256, 2, 0)"),
        ],
        projections=[],
        constraints=constraints if constraints is not None else [LIVE_DIMENSION, LIVE_C3],
        engine="MergeTree",
        order_by="id",
    )


def test_drift_reads_clickhouse_echo_clean_and_collects_fragments() -> None:
    assert compare_table_shape(_expected(), _actual(), CANONICALIZER) is None
    expressions = collect_table_sql_fragments(_expected(), _actual()).expressions
    assert "s IN ('a','b') AND (id+1)*2 > 0" in expressions
    assert "sparse_grams(3,20, 256,2,0)" in expressions


def test_drift_reports_missing_extra_and_changed_constraints() -> None:
    missing = compare_table_shape(_expected(), _actual(constraints=[LIVE_DIMENSION]), CANONICALIZER)
    assert missing is not None
    assert missing.reason_codes == ["constraint_mismatch"]
    assert missing.constraint_diffs == ["c3"]
    extra = compare_table_shape(_expected(constraints=[]), _actual(), CANONICALIZER)
    assert extra is not None
    assert extra.constraint_diffs == ["c3", "dimension"]
    kind = compare_table_shape(
        _expected(),
        _actual(constraints=[TableConstraintDefinition(name="dimension", assume="length(embedding) = 4"),
                             LIVE_C3]),
        CANONICALIZER,
    )
    assert kind is not None
    assert kind.constraint_diffs == ["dimension"]


def test_drift_reports_changed_vector_index_and_matches_raw_spelling() -> None:
    live_sparse = SkipIndexRaw(name="sg", expression="s", granularity=1,
                               raw_type="sparse_grams(3, 20, 256, 2, 0)")
    changed = compare_table_shape(
        _expected(),
        _actual(indexes=[SkipIndexVectorSimilarity.model_validate(
            {**VECTOR4, "distanceFunction": "L2Distance"}), live_sparse]),
        CANONICALIZER,
    )
    assert changed is not None
    assert changed.index_diffs == ["e"]
    raw = {"name": "e", "expression": "embedding", "type": "raw",
           "rawType": "vector_similarity('hnsw', 'cosineDistance', 4)", "granularity": 100_000_000}
    assert compare_table_shape(_expected(indexes=[raw, RAW_SPARSE]), _actual(), CANONICALIZER) is None


# ---------- pull ----------


def test_pull_renders_vector_raw_and_constraints_and_loads_back() -> None:
    definition = vectors(
        indexes=[{**HNSW, "quantization": "bf16", "hnswMaxConnectionsPerLayer": 32,
                  "hnswCandidateListSizeForConstruction": 128},
                 {"name": "sg", "expression": "id", "type": "raw",
                  "rawType": "sparse_grams(3, 20, 256, 2, 0)", "granularity": 1}],
        constraints=[DIMENSION, POSITIVE],
    )
    content = render_schema_file([definition])
    assert "SkipIndexVectorSimilarity(name='embedding_hnsw'" in content or (
        'SkipIndexVectorSimilarity(name="embedding_hnsw"' in content
    )
    namespace: dict[str, Any] = {}
    exec(compile(content, "schema.py", "exec"), namespace)
    assert plan_diff([definition], [namespace["definitions"][0]]).operations == []
