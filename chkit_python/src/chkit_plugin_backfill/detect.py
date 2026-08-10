"""Backfill strategy detection (table vs mv_replay) + time-column candidates.

Port of ``packages/plugin-backfill/src/detect.ts``, including upstream
``f85f568`` (chunks sized from the MV *source* table so empty targets
bootstrap) and ``3f9a246`` (replay **every** MV feeding the target).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from chkit.core.model import (
    MaterializedViewDefinition,
    SchemaDefinition,
    TableDefinition,
)
from chkit_plugin_backfill.chunking.sql import extract_source_table_ref

_DATETIME_TYPES = {"DateTime", "DateTime64"}

_COMMON_TIME_COLUMN_NAMES = {
    "created_at",
    "timestamp",
    "ingested_at",
    "event_time",
    "event_at",
    "occurred_at",
}


class TimeColumnCandidate(BaseModel):
    name: str
    type: str
    source: str = Field(..., pattern="^(order_by|column_scan|schema)$")

    model_config = ConfigDict(frozen=True, extra="forbid")


def _is_datetime_type(type_: str) -> bool:
    if type_ in _DATETIME_TYPES:
        return True
    if type_.startswith("DateTime64("):
        return True
    return type_.startswith("DateTime('")


def find_mvs_for_target(
    definitions: list[SchemaDefinition],
    database: str,
    table: str,
) -> list[MaterializedViewDefinition]:
    """Return every materialized view whose ``to`` target is
    ``database.table``. ClickHouse allows several MVs to feed the same
    destination table, so an mv_replay backfill must replay all of them —
    returning only the first would silently drop the rest.
    """
    return [
        definition
        for definition in definitions
        if isinstance(definition, MaterializedViewDefinition)
        and definition.to.database == database
        and definition.to.name == table
    ]


def resolve_mv_replay_source(
    mvs: list[MaterializedViewDefinition],
) -> dict[str, str] | None:
    """Resolve the single source table an mv_replay backfill should size its
    chunks against — the table the materialized views read ``FROM``. The
    injected chunk conditions (``_partition_id``, sort-key ranges) run against
    that source, so the chunk planner must introspect it rather than the
    target, which is legitimately empty while a fresh aggregate is being
    bootstrapped.

    An unqualified ``FROM`` table defaults to the view's own database, matching
    ClickHouse name resolution. Returns ``None`` when a source can't be
    resolved to a single shared table — either a ``FROM`` we can't parse, or
    MVs fanning in from different sources (which one chunk plan can't drive) —
    so the caller falls back to introspecting the target, preserving
    multi-source replay.
    """
    sources: dict[str, dict[str, str]] = {}

    for mv in mvs:
        ref = extract_source_table_ref(mv.as_)
        if ref is None:
            return None
        database = ref.get("database", mv.database)
        table = ref["table"]
        sources[f"{database}.{table}"] = {"database": database, "table": table}

    distinct = list(sources.values())
    return distinct[0] if len(distinct) == 1 else None


def find_table_for_target(
    definitions: list[SchemaDefinition],
    database: str,
    table: str,
) -> TableDefinition | None:
    for definition in definitions:
        if (
            isinstance(definition, TableDefinition)
            and definition.database == database
            and definition.name == table
        ):
            return definition

    for definition in definitions:
        if (
            isinstance(definition, MaterializedViewDefinition)
            and definition.to.database == database
            and definition.to.name == table
        ):
            for source_definition in definitions:
                if (
                    isinstance(source_definition, TableDefinition)
                    and source_definition.database == definition.database
                ):
                    return source_definition

    return None


def detect_candidates_from_table(table: TableDefinition) -> list[TimeColumnCandidate]:
    candidates: list[TimeColumnCandidate] = []
    seen: set[str] = set()

    order_by_columns = set(table.order_by)
    for col in table.columns:
        if col.name in order_by_columns and _is_datetime_type(col.type):
            candidates.append(
                TimeColumnCandidate(name=col.name, type=col.type, source="order_by")
            )
            seen.add(col.name)

    for col in table.columns:
        if col.name in seen:
            continue
        if col.name in _COMMON_TIME_COLUMN_NAMES and _is_datetime_type(col.type):
            candidates.append(
                TimeColumnCandidate(name=col.name, type=col.type, source="column_scan")
            )
            seen.add(col.name)

    return candidates


def extract_schema_time_column(table: TableDefinition) -> str | None:
    plugins = table.plugins
    if plugins is None:
        return None
    backfill_config = plugins.get("backfill")
    if not isinstance(backfill_config, dict):
        return None
    time_column = backfill_config.get("timeColumn")
    return time_column if isinstance(time_column, str) else None


__all__ = [
    "TimeColumnCandidate",
    "detect_candidates_from_table",
    "extract_schema_time_column",
    "find_mvs_for_target",
    "find_table_for_target",
    "resolve_mv_replay_source",
]
