"""Migration planner: produce a ``MigrationPlan`` from old vs new definitions."""

from __future__ import annotations

import json
import re

from chkit.core.canonical import canonicalize_definitions, definition_key
from chkit.core.diff_primitives import diff_by_name, diff_clauses, diff_settings
from chkit.core.model import (
    ColumnDefinition,
    ColumnRenameSuggestion,
    DictionaryDefinition,
    MaterializedViewDefinition,
    MaterializedViewRefresh,
    MigrationOperation,
    MigrationPlan,
    RiskLevel,
    SchemaDefinition,
    SkipIndexDefinition,
    TableDefinition,
    ViewDefinition,
    _RiskSummary,
)
from chkit.core.sql import (
    render_alter_add_column,
    render_alter_add_index,
    render_alter_add_projection,
    render_alter_drop_column,
    render_alter_drop_index,
    render_alter_drop_projection,
    render_alter_modify_column,
    render_alter_modify_refresh,
    render_alter_modify_setting,
    render_alter_modify_ttl,
    render_alter_remove_codec,
    render_alter_reset_setting,
    render_dictionary_sql,
    to_create_sql,
)
from chkit.core.validate import assert_valid_definitions


def _map_by_key(definitions: list[SchemaDefinition]) -> dict[str, SchemaDefinition]:
    return {definition_key(definition): definition for definition in definitions}


def _push_drop(
    operations: list[MigrationOperation],
    definition: SchemaDefinition,
    risk: RiskLevel = "danger",
) -> None:
    if isinstance(definition, TableDefinition):
        operations.append(
            MigrationOperation(
                type="drop_table",
                key=definition_key(definition),
                risk=risk,
                sql=f"DROP TABLE IF EXISTS {definition.database}.{definition.name};",
            )
        )
        return
    if isinstance(definition, ViewDefinition):
        operations.append(
            MigrationOperation(
                type="drop_view",
                key=definition_key(definition),
                risk=risk,
                sql=f"DROP VIEW IF EXISTS {definition.database}.{definition.name};",
            )
        )
        return
    if isinstance(definition, DictionaryDefinition):
        operations.append(
            MigrationOperation(
                type="drop_dictionary",
                key=definition_key(definition),
                risk=risk,
                sql=(
                    f"DROP DICTIONARY IF EXISTS "
                    f"{definition.database}.{definition.name};"
                ),
            )
        )
        return
    operations.append(
        MigrationOperation(
            type="drop_materialized_view",
            key=definition_key(definition),
            risk=risk,
            sql=f"DROP TABLE IF EXISTS {definition.database}.{definition.name} SYNC;",
        )
    )


def _push_create(
    operations: list[MigrationOperation],
    definition: SchemaDefinition,
    risk: RiskLevel = "safe",
) -> None:
    sql = to_create_sql(definition)
    if isinstance(definition, TableDefinition):
        operations.append(
            MigrationOperation(
                type="create_table",
                key=definition_key(definition),
                risk=risk,
                sql=sql,
            )
        )
        return
    if isinstance(definition, ViewDefinition):
        operations.append(
            MigrationOperation(
                type="create_view",
                key=definition_key(definition),
                risk=risk,
                sql=sql,
            )
        )
        return
    if isinstance(definition, DictionaryDefinition):
        operations.append(
            MigrationOperation(
                type="create_dictionary",
                key=definition_key(definition),
                risk=risk,
                sql=sql,
            )
        )
        return
    operations.append(
        MigrationOperation(
            type="create_materialized_view",
            key=definition_key(definition),
            risk=risk,
            sql=sql,
        )
    )


def _push_create_database(
    operations: list[MigrationOperation], database: str, risk: RiskLevel = "safe"
) -> None:
    operations.append(
        MigrationOperation(
            type="create_database",
            key=f"database:{database}",
            risk=risk,
            sql=f"CREATE DATABASE IF NOT EXISTS {database};",
        )
    )


# Mirrors the JS `\s` class exactly (TS uses /\s/.test(char)); Python's
# str.isspace() differs on U+0085/U+001C-001F (included) and U+FEFF (excluded),
# which would let a pathological key expression diff differently across ports.
_JS_WHITESPACE_RE = re.compile(
    r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
)


def _strip_insignificant_formatting(token: str) -> str:
    """Drop whitespace and identifier backticks for key-clause comparison.

    ClickHouse normalizes both when it stores a key: ``toStartOfHour( ts )``
    comes back as ``toStartOfHour(ts)``, and a column written bare as
    ``user-id`` in config is stored/introspected quoted as ``` `user-id` ```.
    Single/double-quoted string literals are semantic and preserved.
    Comparison-only — never used to render DDL, so keyword expressions like
    ``INTERVAL 1 HOUR`` and real identifier quoting keep their form when
    emitted.
    """
    out: list[str] = []
    quote: str | None = None
    for i, char in enumerate(token):
        if quote is not None:
            out.append(char)
            if char == quote and (i == 0 or token[i - 1] != "\\"):
                quote = None
            continue
        if char in ("'", '"'):
            quote = char
            out.append(char)
            continue
        if char == "`":
            continue
        if _JS_WHITESPACE_RE.match(char) is not None:
            continue
        out.append(char)
    return "".join(out)


def _join_clause(values: list[str] | None) -> str:
    return ",".join(_strip_insignificant_formatting(value) for value in values or [])


def _requires_table_recreate(old: TableDefinition, new: TableDefinition) -> bool:
    return diff_clauses(
        [
            (old.engine, new.engine),
            (_join_clause(old.primary_key), _join_clause(new.primary_key)),
            (_join_clause(old.order_by), _join_clause(new.order_by)),
            (old.partition_by or "", new.partition_by or ""),
            (_join_clause(old.unique_key), _join_clause(new.unique_key)),
        ]
    )


def _column_identity(column: ColumnDefinition) -> str:
    """JSON-stable shape of a column ignoring name + renamed_from."""
    data = column.model_dump(mode="json", by_alias=False)
    data.pop("name", None)
    data.pop("renamed_from", None)
    return json.dumps(data, sort_keys=True, default=str)


def _column_identity_without_codec(column: ColumnDefinition) -> str:
    data = column.model_dump(mode="json", by_alias=False)
    data.pop("name", None)
    data.pop("renamed_from", None)
    data.pop("codec", None)
    return json.dumps(data, sort_keys=True, default=str)


def _columns_equal(left: ColumnDefinition, right: ColumnDefinition) -> bool:
    return _column_identity(left) == _column_identity(right)


def _index_identity(index: SkipIndexDefinition) -> str:
    return json.dumps(index.model_dump(mode="json", by_alias=False), sort_keys=True, default=str)


def _indexes_equal(left: SkipIndexDefinition, right: SkipIndexDefinition) -> bool:
    return _index_identity(left) == _index_identity(right)


def _is_codec_removal(old: ColumnDefinition, new: ColumnDefinition) -> bool:
    if old.codec is None or new.codec is not None:
        return False
    return _column_identity_without_codec(old) == _column_identity_without_codec(new)


def _render_rename_column_suggestion_sql(
    table: TableDefinition, from_: str, to: str
) -> str:
    return (
        f"ALTER TABLE {table.database}.{table.name} "
        f"RENAME COLUMN `{from_}` TO `{to}`;"
    )


def _infer_column_rename_suggestions(
    table: TableDefinition,
    added: list[ColumnDefinition],
    dropped: list[ColumnDefinition],
) -> list[ColumnRenameSuggestion]:
    if not added or not dropped:
        return []

    by_signature: dict[str, list[ColumnDefinition]] = {}
    for column in added:
        signature = _column_identity(column)
        by_signature.setdefault(signature, []).append(column)

    suggestions: list[ColumnRenameSuggestion] = []
    for old_column in dropped:
        signature = _column_identity(old_column)
        candidates = by_signature.get(signature)
        if candidates is None or len(candidates) != 1:
            continue
        candidate = candidates[0]
        del by_signature[signature]

        suggestions.append(
            ColumnRenameSuggestion.model_validate(
                {
                    "kind": "column",
                    "database": table.database,
                    "table": table.name,
                    "from": old_column.name,
                    "to": candidate.name,
                    "confidence": "high",
                    "reason": (
                        "Dropped and added columns have an identical non-name "
                        "definition (type, nullability, default, comment)."
                    ),
                    "dropOperationKey": (
                        f"table:{table.database}.{table.name}:column:{old_column.name}"
                    ),
                    "addOperationKey": (
                        f"table:{table.database}.{table.name}:column:{candidate.name}"
                    ),
                    "confirmationSQL": _render_rename_column_suggestion_sql(
                        table, old_column.name, candidate.name
                    ),
                }
            )
        )

    suggestions.sort(
        key=lambda s: (f"{s.database}.{s.table}", s.from_, s.to)
    )
    return suggestions


def _refresh_equal(
    old: MaterializedViewRefresh | None, new: MaterializedViewRefresh | None
) -> bool:
    a = old.model_dump(mode="json") if old is not None else None
    b = new.model_dump(mode="json") if new is not None else None
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


def _diff_materialized_view(
    old: MaterializedViewDefinition, new: MaterializedViewDefinition
) -> list[MigrationOperation]:
    old_append = old.refresh is not None and old.refresh.append is True
    new_append = new.refresh is not None and new.refresh.append is True
    has_old_refresh = old.refresh is not None
    has_new_refresh = new.refresh is not None

    structural = (
        new.as_ != old.as_
        or new.comment != old.comment
        or new.to.database != old.to.database
        or new.to.name != old.to.name
        or has_old_refresh != has_new_refresh
        or old_append != new_append
    )

    if structural:
        return [
            MigrationOperation(
                type="drop_materialized_view",
                key=definition_key(new),
                risk="caution",
                sql=f"DROP TABLE IF EXISTS {new.database}.{new.name} SYNC;",
            ),
            MigrationOperation(
                type="create_materialized_view",
                key=definition_key(new),
                risk="caution",
                sql=to_create_sql(new),
            ),
        ]

    if has_new_refresh and not _refresh_equal(old.refresh, new.refresh):
        return [
            MigrationOperation(
                type="alter_materialized_view_modify_refresh",
                key=f"materialized_view:{new.database}.{new.name}:refresh",
                risk="caution",
                sql=render_alter_modify_refresh(new),
            )
        ]

    return []


def _diff_tables(
    old: TableDefinition, new: TableDefinition
) -> tuple[list[MigrationOperation], list[ColumnRenameSuggestion]]:
    if _requires_table_recreate(old, new):
        return (
            [
                MigrationOperation(
                    type="drop_table",
                    key=definition_key(new),
                    risk="danger",
                    sql=f"DROP TABLE IF EXISTS {new.database}.{new.name};",
                ),
                MigrationOperation(
                    type="create_table",
                    key=definition_key(new),
                    risk="safe",
                    sql=to_create_sql(new),
                ),
            ],
            [],
        )

    ops: list[MigrationOperation] = []
    column_diff = diff_by_name(
        list(old.columns),
        list(new.columns),
        lambda c: c.name,
        _columns_equal,
    )
    added_columns = column_diff.added
    dropped_columns = column_diff.removed
    for column in column_diff.added:
        ops.append(
            MigrationOperation(
                type="alter_table_add_column",
                key=f"table:{new.database}.{new.name}:column:{column.name}",
                risk="safe",
                sql=render_alter_add_column(new, column),
            )
        )
    for column_change in column_diff.changed:
        sql = (
            render_alter_remove_codec(new, column_change.name)
            if _is_codec_removal(column_change.old_item, column_change.new_item)
            else render_alter_modify_column(new, column_change.new_item)
        )
        ops.append(
            MigrationOperation(
                type="alter_table_modify_column",
                key=f"table:{new.database}.{new.name}:column:{column_change.name}",
                risk="caution",
                sql=sql,
            )
        )
    for column in column_diff.removed:
        ops.append(
            MigrationOperation(
                type="alter_table_drop_column",
                key=f"table:{new.database}.{new.name}:column:{column.name}",
                risk="danger",
                sql=render_alter_drop_column(new, column.name),
            )
        )

    index_diff = diff_by_name(
        list(old.indexes or []),
        list(new.indexes or []),
        lambda i: i.name,
        _indexes_equal,
    )
    for index in index_diff.added:
        ops.append(
            MigrationOperation(
                type="alter_table_add_index",
                key=f"table:{new.database}.{new.name}:index:{index.name}",
                risk="caution",
                sql=render_alter_add_index(new, index),
            )
        )
    for index_change in index_diff.changed:
        ops.append(
            MigrationOperation(
                type="alter_table_drop_index",
                key=f"table:{new.database}.{new.name}:index:{index_change.name}",
                risk="caution",
                sql=render_alter_drop_index(new, index_change.name),
            )
        )
        ops.append(
            MigrationOperation(
                type="alter_table_add_index",
                key=f"table:{new.database}.{new.name}:index:{index_change.name}",
                risk="caution",
                sql=render_alter_add_index(new, index_change.new_item),
            )
        )
    for index in index_diff.removed:
        ops.append(
            MigrationOperation(
                type="alter_table_drop_index",
                key=f"table:{new.database}.{new.name}:index:{index.name}",
                risk="caution",
                sql=render_alter_drop_index(new, index.name),
            )
        )

    projection_diff = diff_by_name(
        list(old.projections or []),
        list(new.projections or []),
        lambda p: p.name,
        lambda left, right: json.dumps(
            left.model_dump(mode="json"), sort_keys=True, default=str
        )
        == json.dumps(right.model_dump(mode="json"), sort_keys=True, default=str),
    )
    for projection in projection_diff.added:
        ops.append(
            MigrationOperation(
                type="alter_table_add_projection",
                key=f"table:{new.database}.{new.name}:projection:{projection.name}",
                risk="caution",
                sql=render_alter_add_projection(new, projection),
            )
        )
    for projection_change in projection_diff.changed:
        ops.append(
            MigrationOperation(
                type="alter_table_drop_projection",
                key=(
                    f"table:{new.database}.{new.name}:projection:"
                    f"{projection_change.name}"
                ),
                risk="caution",
                sql=render_alter_drop_projection(new, projection_change.name),
            )
        )
        ops.append(
            MigrationOperation(
                type="alter_table_add_projection",
                key=(
                    f"table:{new.database}.{new.name}:projection:"
                    f"{projection_change.name}"
                ),
                risk="caution",
                sql=render_alter_add_projection(new, projection_change.new_item),
            )
        )
    for projection in projection_diff.removed:
        ops.append(
            MigrationOperation(
                type="alter_table_drop_projection",
                key=f"table:{new.database}.{new.name}:projection:{projection.name}",
                risk="caution",
                sql=render_alter_drop_projection(new, projection.name),
            )
        )

    setting_diff = diff_settings(old.settings or {}, new.settings or {})
    for setting_change in setting_diff.changes:
        if setting_change.kind == "reset":
            ops.append(
                MigrationOperation(
                    type="alter_table_reset_setting",
                    key=(
                        f"table:{new.database}.{new.name}:setting:"
                        f"{setting_change.key}"
                    ),
                    risk="caution",
                    sql=render_alter_reset_setting(new, setting_change.key),
                )
            )
            continue
        ops.append(
            MigrationOperation(
                type="alter_table_modify_setting",
                key=(
                    f"table:{new.database}.{new.name}:setting:"
                    f"{setting_change.key}"
                ),
                risk="caution",
                sql=render_alter_modify_setting(
                    new, setting_change.key, setting_change.value
                ),
            )
        )

    if (old.ttl or "") != (new.ttl or ""):
        ops.append(
            MigrationOperation(
                type="alter_table_modify_ttl",
                key=f"table:{new.database}.{new.name}:ttl",
                risk="caution",
                sql=render_alter_modify_ttl(new, new.ttl),
            )
        )

    rename_suggestions = _infer_column_rename_suggestions(new, added_columns, dropped_columns)
    return ops, rename_suggestions


def _rank(op: MigrationOperation) -> int:
    t = op.type
    if t.startswith("drop_"):
        return 0
    if t == "alter_materialized_view_modify_refresh":
        return 1
    if t.startswith("alter_"):
        return 1
    if t == "create_database":
        return 2
    if t == "create_table":
        return 3
    if t == "create_view":
        return 4
    return 5


def _dictionary_source_is_hidden(source: str) -> bool:
    # `chkit pull` writes ClickHouse's own introspection placeholder
    # (`password '[HIDDEN]'`) into `source` when it can't recover a
    # dictionary's real credential. That placeholder must never drive a diff —
    # rendering it would deploy the literal string "[HIDDEN]" as the password.
    # A real password value, by contrast, is fully known to chkit (it's a
    # plain string in the schema file) and a change to it is a genuine diff
    # like any other.
    return "[HIDDEN]" in source


def _dictionary_comparison_shape(
    definition: DictionaryDefinition, omit_source: bool
) -> dict[str, object]:
    shape = definition.model_dump(by_alias=True)
    if omit_source:
        shape.pop("source", None)
    return shape


def _diff_dictionary(
    old: DictionaryDefinition, new: DictionaryDefinition
) -> list[MigrationOperation]:
    omit_source = _dictionary_source_is_hidden(new.source)
    if _dictionary_comparison_shape(old, omit_source) == _dictionary_comparison_shape(
        new, omit_source
    ):
        return []

    return [
        MigrationOperation(
            type="create_dictionary",
            key=definition_key(new),
            risk="caution",
            sql=render_dictionary_sql(new, replace=True),
        )
    ]


def plan_diff(
    old_definitions: list[SchemaDefinition], new_definitions: list[SchemaDefinition]
) -> MigrationPlan:
    old_canonical = canonicalize_definitions(old_definitions)
    new_canonical = canonicalize_definitions(new_definitions)
    assert_valid_definitions(new_canonical)
    old_map = _map_by_key(old_canonical)
    new_map = _map_by_key(new_canonical)
    operations: list[MigrationOperation] = []
    rename_suggestions: list[ColumnRenameSuggestion] = []
    databases_to_create: set[str] = set()

    for old_def in old_canonical:
        if definition_key(old_def) in new_map:
            continue
        _push_drop(operations, old_def, "danger")

    for new_def in new_canonical:
        key = definition_key(new_def)
        matched = old_map.get(key)
        if matched is None:
            continue

        if isinstance(new_def, TableDefinition) and isinstance(matched, TableDefinition):
            ops, renames = _diff_tables(matched, new_def)
            operations.extend(ops)
            rename_suggestions.extend(renames)
            continue

        if isinstance(new_def, ViewDefinition) and isinstance(matched, ViewDefinition):
            if new_def.as_ != matched.as_ or new_def.comment != matched.comment:
                _push_drop(operations, matched, "caution")
                _push_create(operations, new_def, "caution")
            continue

        if isinstance(new_def, MaterializedViewDefinition) and isinstance(
            matched, MaterializedViewDefinition
        ):
            operations.extend(_diff_materialized_view(matched, new_def))
            continue

        if isinstance(new_def, DictionaryDefinition) and isinstance(
            matched, DictionaryDefinition
        ):
            operations.extend(_diff_dictionary(matched, new_def))
            continue

        if type(new_def) is not type(matched):
            _push_drop(operations, matched, "danger")

    for new_def in new_canonical:
        key = definition_key(new_def)
        existing = old_map.get(key)
        if existing is not None and type(existing) is type(new_def):
            continue
        databases_to_create.add(new_def.database)
        _push_create(operations, new_def, "safe")

    for database in sorted(databases_to_create):
        _push_create_database(operations, database, "safe")

    operations.sort(key=lambda op: (_rank(op), op.key))

    counts: dict[RiskLevel, int] = {"safe": 0, "caution": 0, "danger": 0}
    for op in operations:
        counts[op.risk] = counts[op.risk] + 1

    rename_suggestions.sort(key=lambda s: (f"{s.database}.{s.table}", s.from_, s.to))

    return MigrationPlan.model_validate(
        {
            "operations": [op.model_dump(by_alias=True) for op in operations],
            "riskSummary": _RiskSummary(
                safe=counts["safe"], caution=counts["caution"], danger=counts["danger"]
            ).model_dump(),
            "renameSuggestions": [s.model_dump(by_alias=True) for s in rename_suggestions],
        }
    )
