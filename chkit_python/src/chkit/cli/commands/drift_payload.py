"""Build the full live-DB drift payload (snapshot ↔ ClickHouse).

1:1 port of ``packages/cli/src/commands/drift/payload.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from chkit.cli.commands.drift_compare import (
    KindMismatch,
    ObjectDriftDetail,
    SchemaObjectShape,
    TableDriftDetail,
    compare_schema_objects,
    compare_table_shape,
)
from chkit.cli.table_scope import TableScope
from chkit.clickhouse.introspect import (
    list_schema_objects,
    list_table_details,
)
from chkit.core.model import Snapshot, TableDefinition


@dataclass(frozen=True, slots=True)
class DriftPayload:
    snapshot_file: str
    expected_count: int
    actual_count: int
    drifted: bool
    missing: list[str]
    extra: list[str]
    kind_mismatches: list[KindMismatch]
    object_drift: list[ObjectDriftDetail]
    table_drift: list[TableDriftDetail]
    scope: TableScope | None = None
    database_missing: bool = False
    database: str | None = None


@dataclass(frozen=True, slots=True)
class DriftedFlags:
    missing_count: int
    kind_mismatch_count: int
    table_drift_count: int
    extra_count: int
    fail_on_extra_objects: bool


def compute_drifted(flags: DriftedFlags) -> bool:
    """Return True if any drift category should fire the drift gate.

    ``extra_object`` is opt-in via ``check.failOnExtraObjects`` because in
    a shared database every unmanaged table would otherwise trip CI.
    """
    return (
        flags.missing_count > 0
        or flags.kind_mismatch_count > 0
        or flags.table_drift_count > 0
        or (flags.fail_on_extra_objects and flags.extra_count > 0)
    )


def _is_unknown_database_error(error: BaseException) -> bool:
    """Detect ClickHouse error code 81 (Unknown database) by message match."""
    message = str(error)
    return (
        "UNKNOWN_DATABASE" in message
        or "code: 81" in message
        or ("Database " in message
        and "doesn't exist" in message)
    )


def build_drift_payload(
    *,
    client: Any,
    meta_dir: Path,
    snapshot: Snapshot,
    database: str | None,
    fail_on_extra_objects: bool = False,
    scope: TableScope | None = None,
) -> DriftPayload:
    """Run live introspection and produce the full DriftPayload."""
    selected_tables: set[str] | None = (
        set(scope.matched_tables)
        if scope is not None and scope.enabled and scope.match_count > 0
        else None
    )

    snapshot_file = str(meta_dir / "snapshot.json")

    def _expected_filtered() -> list[Any]:
        return [
            d
            for d in snapshot.definitions
            if (
                selected_tables is None
                or not isinstance(d, TableDefinition)
                or f"{d.database}.{d.name}" in selected_tables
            )
        ]

    try:
        actual_objects = list_schema_objects(client)
    except Exception as error:
        if _is_unknown_database_error(error):
            all_expected = [
                f"{d.database}.{d.name}" for d in _expected_filtered()
            ]
            return DriftPayload(
                snapshot_file=snapshot_file,
                expected_count=len(all_expected),
                actual_count=0,
                drifted=len(all_expected) > 0,
                database_missing=True,
                database=database,
                missing=all_expected,
                extra=[],
                kind_mismatches=[],
                object_drift=[],
                table_drift=[],
                scope=scope,
            )
        raise

    expected_filtered = _expected_filtered()
    expected_objects = [
        SchemaObjectShape(kind=d.kind, database=d.database, name=d.name)
        for d in expected_filtered
    ]
    expected_databases = {d.database for d in expected_filtered}
    actual_in_scope = [
        SchemaObjectShape(kind=o.kind, database=o.database, name=o.name)
        for o in actual_objects
        if o.database in expected_databases
    ]

    compare_result = compare_schema_objects(expected_objects, actual_in_scope)

    expected_tables = [
        d
        for d in expected_filtered
        if isinstance(d, TableDefinition)
        and (selected_tables is None or f"{d.database}.{d.name}" in selected_tables)
    ]
    expected_table_map: dict[str, TableDefinition] = {
        f"{t.database}.{t.name}": t for t in expected_tables
    }

    actual_tables = list_table_details(client, sorted(expected_databases))
    table_drift_unsorted: list[TableDriftDetail] = []
    for actual in actual_tables:
        expected = expected_table_map.get(f"{actual.database}.{actual.name}")
        if expected is None:
            continue
        detail = compare_table_shape(expected, actual)
        if detail is not None:
            table_drift_unsorted.append(detail)
    table_drift = sorted(table_drift_unsorted, key=lambda d: d.table)

    drifted = compute_drifted(
        DriftedFlags(
            missing_count=len(compare_result.missing),
            kind_mismatch_count=len(compare_result.kind_mismatches),
            table_drift_count=len(table_drift),
            extra_count=len(compare_result.extra),
            fail_on_extra_objects=fail_on_extra_objects,
        )
    )

    return DriftPayload(
        snapshot_file=snapshot_file,
        expected_count=len(expected_objects),
        actual_count=len(actual_in_scope),
        drifted=drifted,
        missing=compare_result.missing,
        extra=compare_result.extra,
        kind_mismatches=compare_result.kind_mismatches,
        object_drift=compare_result.object_drift,
        table_drift=table_drift,
        scope=scope,
    )
