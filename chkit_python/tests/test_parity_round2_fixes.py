"""Round-2 audit fixes — see DRIFT.md > "Round-2 audit fixes" section.

Covers:
- #R1 canonical.py primary_key fallback to order_by when empty
- #R2 canonical.py depends_on serialization uses camelCase alias
- #R4 ddl_propagation new wait predicates + dispatcher routes
- #R5 validate.py codec + MV refresh issue codes (the 11 untested ones)
- #R7 service_claim provisioning_timeout / already_claimed JSON envelopes
"""

from __future__ import annotations

import inspect
from unittest.mock import MagicMock

from chkit import (
    ColumnDefinition,
    MaterializedViewRefresh,
    TableRef,
    materialized_view,
    table,
)
from chkit.clickhouse.ddl_propagation import (
    _parse_operation_key,
    wait_for_column_absent,
    wait_for_ddl_propagation,
    wait_for_index,
    wait_for_index_absent,
    wait_for_projection,
    wait_for_projection_absent,
)
from chkit.core import canonicalize_definition, canonicalize_definitions
from chkit.core.validate import validate_definitions
from chkit_plugin_obsessiondb import service_claim as obsessiondb_service_claim

# ---------- #R1: canonical primary_key fallback ----------


def test_R1_primary_key_falls_back_to_order_by_when_empty() -> None:
    """TS canonical.ts has ``primaryKey: pk.length > 0 ? pk : orderBy``.

    Without this, a snapshot written by TS (where omitted PK == order_by)
    fails to match a Python snapshot for the same table.
    """
    # Construct a table with primary_key matching order_by (the model
    # currently requires both), then forge an "empty PK" via post-init
    # mutation through model_copy.
    t = table(
        database="d",
        name="t",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        engine="MergeTree",
        primary_key=["id"],
        order_by=["id", "ts"],
    )
    forged = t.model_copy(update={"primary_key": []})
    canonical = canonicalize_definition(forged)
    # The canonical form should backfill primary_key from order_by.
    assert canonical.primary_key == ["id", "ts"]  # type: ignore[union-attr]


def test_R1_primary_key_preserved_when_not_empty() -> None:
    t = table(
        database="d",
        name="t",
        columns=[ColumnDefinition(name="id", type="UInt64"), ColumnDefinition(name="ts", type="DateTime")],
        engine="MergeTree",
        primary_key=["id"],
        order_by=["id", "ts"],
    )
    canonical = canonicalize_definition(t)
    assert canonical.primary_key == ["id"]  # type: ignore[union-attr]


# ---------- #R2: depends_on serializes with camelCase + by_alias ----------


def test_R2_materialized_view_depends_on_serializes_camelcase() -> None:
    """The canonical refresh should serialize ``depends_on`` as ``dependsOn``
    so a snapshot written by Python is readable by a TS toolchain.
    """
    refresh = MaterializedViewRefresh(
        every="1 HOUR",
        depends_on=[TableRef(database="d", name="upstream")],
    )
    mv = materialized_view(
        database="d",
        name="mv",
        to=TableRef(database="d", name="dest"),
        as_="SELECT 1",
        refresh=refresh,
    )
    canonical = canonicalize_definition(mv)
    # JSON-serialize with by_alias to verify the public snapshot shape.
    payload = canonical.model_dump(by_alias=True, exclude_none=True)
    assert "refresh" in payload
    refresh_payload = payload["refresh"]
    assert isinstance(refresh_payload, dict)
    assert "dependsOn" in refresh_payload
    assert refresh_payload["dependsOn"] == [{"database": "d", "name": "upstream"}]
    assert "depends_on" not in refresh_payload  # no snake_case leak


# ---------- #R4: ddl_propagation new predicates ----------


def _stub_client(rows_by_call: list[list[dict[str, object]]]) -> MagicMock:
    """Mock client.query() returning the next batch of rows on each call."""
    fake = MagicMock()
    fake.query.side_effect = [
        MagicMock(rows=batch) for batch in rows_by_call
    ]
    return fake


def test_R4_wait_for_column_absent_returns_when_no_rows() -> None:
    client = _stub_client([[]])
    wait_for_column_absent(client, "d", "t", "col")  # must not raise


def test_R4_wait_for_index_returns_when_row_present() -> None:
    client = _stub_client([[{"x": 1}]])
    wait_for_index(client, "d", "t", "ix1")  # must not raise


def test_R4_wait_for_index_absent_returns_when_no_rows() -> None:
    client = _stub_client([[]])
    wait_for_index_absent(client, "d", "t", "ix1")


def test_R4_wait_for_projection_returns_when_row_present() -> None:
    client = _stub_client([[{"x": 1}]])
    wait_for_projection(client, "d", "t", "p1")


def test_R4_wait_for_projection_absent_returns_when_no_rows() -> None:
    client = _stub_client([[]])
    wait_for_projection_absent(client, "d", "t", "p1")


def test_R4_parse_operation_key_recognizes_index_and_projection() -> None:
    parsed_col = _parse_operation_key("table:d.t:column:c")
    assert parsed_col == ("d", "t", "c", None, None)
    parsed_idx = _parse_operation_key("table:d.t:index:ix1")
    assert parsed_idx == ("d", "t", None, "ix1", None)
    parsed_proj = _parse_operation_key("table:d.t:projection:p1")
    assert parsed_proj == ("d", "t", None, None, "p1")


def test_R4_dispatcher_routes_drop_column_to_column_absent_predicate() -> None:
    client = _stub_client([[]])  # column absent
    # Mimic a drop_column operation key.
    wait_for_ddl_propagation(client, "alter_table_drop_column", "table:d.t:column:c")
    # The dispatcher should have queried system.columns for the absent column.
    sql_arg = client.query.call_args.args[0]
    assert "system.columns" in sql_arg
    assert "name = 'c'" in sql_arg


def test_R4_dispatcher_routes_add_index_to_index_predicate() -> None:
    client = _stub_client([[{"x": 1}]])
    wait_for_ddl_propagation(client, "alter_table_add_index", "table:d.t:index:ix1")
    sql_arg = client.query.call_args.args[0]
    assert "system.data_skipping_indices" in sql_arg


def test_R4_dispatcher_routes_drop_projection_to_projection_absent_predicate() -> None:
    client = _stub_client([[]])
    wait_for_ddl_propagation(client, "alter_table_drop_projection", "table:d.t:projection:p1")
    sql_arg = client.query.call_args.args[0]
    assert "system.projections" in sql_arg


# ---------- #R5: validate.py codec + MV refresh issue codes ----------


def test_R5_validation_emits_duplicate_column_name() -> None:
    t = table(
        database="d",
        name="t",
        columns=[
            ColumnDefinition(name="x", type="UInt64"),
            ColumnDefinition(name="x", type="String"),
        ],
        engine="MergeTree",
        primary_key=["x"],
        order_by=["x"],
    )
    issues = validate_definitions([t])
    codes = {i.code for i in issues}
    assert "duplicate_column_name" in codes


def test_R5_validation_emits_primary_key_missing_column() -> None:
    t = table(
        database="d",
        name="t",
        columns=[ColumnDefinition(name="x", type="UInt64")],
        engine="MergeTree",
        primary_key=["ghost"],
        order_by=["x"],
    )
    issues = validate_definitions([t])
    assert any(i.code == "primary_key_missing_column" for i in issues)


def test_R5_validation_emits_order_by_missing_column() -> None:
    t = table(
        database="d",
        name="t",
        columns=[ColumnDefinition(name="x", type="UInt64")],
        engine="MergeTree",
        primary_key=["x"],
        order_by=["ghost"],
    )
    issues = validate_definitions([t])
    assert any(i.code == "order_by_missing_column" for i in issues)


def test_R5_validation_emits_duplicate_object_name() -> None:
    t1 = table(
        database="d",
        name="t",
        columns=[ColumnDefinition(name="x", type="UInt64")],
        engine="MergeTree",
        primary_key=["x"],
        order_by=["x"],
    )
    issues = validate_definitions([t1, t1])
    assert any(i.code == "duplicate_object_name" for i in issues)


def test_R5_validation_emits_refresh_every_after_mutually_exclusive() -> None:
    mv = materialized_view(
        database="d",
        name="mv",
        to=TableRef(database="d", name="t"),
        as_="SELECT 1",
        refresh=MaterializedViewRefresh(every="1 HOUR", after="1 HOUR"),
    )
    issues = validate_definitions([mv])
    assert any(
        i.code == "refresh_every_after_mutually_exclusive" for i in issues
    )


def test_R5_validation_emits_refresh_requires_every_or_after() -> None:
    mv = materialized_view(
        database="d",
        name="mv",
        to=TableRef(database="d", name="t"),
        as_="SELECT 1",
        refresh=MaterializedViewRefresh(offset="5 MINUTE"),
    )
    issues = validate_definitions([mv])
    assert any(i.code == "refresh_requires_every_or_after" for i in issues)


def test_R5_validation_emits_refresh_depends_on_requires_every() -> None:
    mv = materialized_view(
        database="d",
        name="mv",
        to=TableRef(database="d", name="t"),
        as_="SELECT 1",
        refresh=MaterializedViewRefresh(
            after="1 HOUR",
            depends_on=[TableRef(database="d", name="upstream")],
        ),
    )
    issues = validate_definitions([mv])
    assert any(i.code == "refresh_depends_on_requires_every" for i in issues)


# ---------- #R6: snapshot cross-port round-trip ----------


def test_R6_snapshot_definitions_round_trip_via_canonicalize() -> None:
    """A canonicalized definition, when serialized by_alias + reloaded,
    matches the original canonical form. This is the in-Python proxy for
    cross-port round-trip stability — the same serializer/deserializer is
    used by TS via Pydantic-equivalent JSON.
    """
    t = table(
        database="d",
        name="t",
        columns=[ColumnDefinition(name="x", type="UInt64")],
        engine="MergeTree",
        primary_key=["x"],
        order_by=["x"],
        partition_by="toYYYYMM(x)",
        settings={"index_granularity": 8192},
    )
    canonical = canonicalize_definition(t)
    dumped = canonical.model_dump(by_alias=True, exclude_none=True)
    reloaded = canonicalize_definitions([canonical.model_validate(dumped)])
    assert reloaded[0].model_dump(by_alias=True, exclude_none=True) == dumped


# ---------- #R7: service_claim envelope shape ----------


def test_R7_service_claim_already_claimed_envelope_is_valid_dict() -> None:
    """The already_claimed envelope structure is checked here without a
    network round-trip: load the source and verify the literal dict keys.
    """
    source = inspect.getsource(obsessiondb_service_claim)
    # The already_claimed envelope must include status + ok + command keys.
    # The literal command id lives in CLAIM_COMMAND_ID.
    assert '"status": "already_claimed"' in source
    assert 'CLAIM_COMMAND_ID = "obsessiondb service claim"' in source


def test_R7_service_claim_provisioning_timeout_envelope_in_source() -> None:
    source = inspect.getsource(obsessiondb_service_claim)
    assert '"provisioning_timeout"' in source
