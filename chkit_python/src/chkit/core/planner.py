"""Migration planner: produce a ``MigrationPlan`` from old vs new definitions."""

from __future__ import annotations

import heapq
import json
import re
from collections.abc import Iterable, Sequence
from typing import Any

from chkit.core.canonical import canonicalize_definitions, definition_key
from chkit.core.column_default import (
    literal_default_fingerprint,
    parse_column_default,
    render_default,
)
from chkit.core.constraint import constraint_kind
from chkit.core.diff_primitives import diff_by_name, diff_clauses, diff_settings
from chkit.core.engine import is_distributed_engine
from chkit.core.identifier import quote_identifier, render_identifier, render_qualified_name
from chkit.core.kafka import is_kafka_engine, kafka_setting_fingerprint
from chkit.core.model import (
    ChxValidationError,
    ColumnDefaultValue,
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
    TableConstraintDefinition,
    TableDefinition,
    ValidationIssue,
    ViewDefinition,
    _RiskSummary,
)
from chkit.core.object_dependencies import (
    DependencyGraph,
    build_dependency_graph,
    invert_dependency_graph,
    order_by_dependencies,
    strongly_connected_components,
)
from chkit.core.sql import (
    column_codec_fingerprint,
    column_type_fingerprint,
    key_fingerprint,
    render_alter_add_column,
    render_alter_add_constraint,
    render_alter_add_index,
    render_alter_add_projection,
    render_alter_comment_column,
    render_alter_drop_column,
    render_alter_drop_constraint,
    render_alter_drop_index,
    render_alter_drop_projection,
    render_alter_modify_column,
    render_alter_modify_comment,
    render_alter_modify_refresh,
    render_alter_modify_setting,
    render_alter_modify_ttl,
    render_alter_remove_codec,
    render_alter_remove_column_comment,
    render_alter_remove_column_expression,
    render_alter_reset_setting,
    render_dictionary_sql,
    to_create_sql,
)
from chkit.core.sql_lexer import (
    SQLToken,
    identifier_name,
    is_trivia,
    js_regex,
    js_trim,
    tokenize_sql,
)
from chkit.core.sql_normalizer import sql_expression_fingerprint
from chkit.core.table_settings import readonly_settings_fingerprint
from chkit.core.text_index import text_index_fingerprint
from chkit.core.validate import assert_valid_definitions


def _map_by_key(definitions: list[SchemaDefinition]) -> dict[str, SchemaDefinition]:
    return {definition_key(definition): definition for definition in definitions}


def _push_drop(
    operations: list[MigrationOperation],
    definition: SchemaDefinition,
    risk: RiskLevel = "danger",
) -> None:
    name = render_qualified_name(definition.database, definition.name)
    if isinstance(definition, TableDefinition):
        operations.append(
            MigrationOperation(
                type="drop_table",
                key=definition_key(definition),
                risk=risk,
                sql=f"DROP TABLE IF EXISTS {name}"
                + (" SYNC;" if is_kafka_engine(definition.engine) else ";"),
            )
        )
        return
    if isinstance(definition, ViewDefinition):
        operations.append(
            MigrationOperation(
                type="drop_view",
                key=definition_key(definition),
                risk=risk,
                sql=f"DROP VIEW IF EXISTS {name};",
            )
        )
        return
    if isinstance(definition, DictionaryDefinition):
        operations.append(
            MigrationOperation(
                type="drop_dictionary",
                key=definition_key(definition),
                risk=risk,
                sql=f"DROP DICTIONARY IF EXISTS {name};",
            )
        )
        return
    operations.append(
        MigrationOperation(
            type="drop_materialized_view",
            key=definition_key(definition),
            risk=risk,
            sql=f"DROP TABLE IF EXISTS {name} SYNC;",
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
            sql=f"CREATE DATABASE IF NOT EXISTS {render_identifier(database)};",
        )
    )


def _requires_table_recreate(old: TableDefinition, new: TableDefinition) -> bool:
    return diff_clauses(
        [
            (old.engine, new.engine),
            (key_fingerprint(old, old.primary_key), key_fingerprint(new, new.primary_key)),
            (key_fingerprint(old, old.order_by), key_fingerprint(new, new.order_by)),
            (old.partition_by or "", new.partition_by or ""),
            (key_fingerprint(old, old.unique_key), key_fingerprint(new, new.unique_key)),
            # ClickHouse refuses to change or reset these on an existing table (#466).
            (
                readonly_settings_fingerprint(old.settings),
                readonly_settings_fingerprint(new.settings),
            ),
        ]
    )


def _normalized_column(column: ColumnDefinition) -> dict[str, Any]:
    """Column shape ignoring name + renamed_from, with the type as rendered.

    Compare what the DSL renders: inline ``Nullable(T)`` and ``nullable=True``
    are equivalent, while an additional or differently placed wrapper is not.
    A literal default compares by the SQL it renders, so the literal ``7`` and
    the expression ``'7'`` that pull reads back are the same default (#466).
    An expression keeps its comments, which the snapshot records as written.
    """
    data = column.model_dump(mode="json", by_alias=False)
    data.pop("name", None)
    data.pop("renamed_from", None)
    data.pop("nullable", None)
    # ClickHouse stores ``Decimal(10,2)`` as ``Decimal(10, 2)`` (#466).
    data["type"] = column_type_fingerprint(column)
    if column.default is not None:
        parsed = parse_column_default(column.default)
        sql = parsed.sql if parsed.kind == "expression" else render_default(column.default)
        data["default"] = literal_default_fingerprint(sql) or sql
    # Codecs compare in the form ClickHouse stores them, like drift (#465).
    data["codec"] = column_codec_fingerprint(column)
    return data


def _column_identity(column: ColumnDefinition) -> str:
    """JSON-stable shape of a column ignoring name + renamed_from."""
    return json.dumps(_normalized_column(column), sort_keys=True, default=str)


def _column_identity_after_removals(column: ColumnDefinition, remove_comment: bool) -> str:
    """A column without its codec, and without its comment.

    The comment is left out when the plan removes it in its own operation.
    """
    data = _normalized_column(column)
    data.pop("codec", None)
    if remove_comment:
        data.pop("comment", None)
    return json.dumps(data, sort_keys=True, default=str)


def _columns_equal(left: ColumnDefinition, right: ColumnDefinition) -> bool:
    return _column_identity(left) == _column_identity(right)


def _index_identity(index: SkipIndexDefinition) -> str:
    # chkit renders ``INDEX name (expr)``. Stock ClickHouse stores ``s`` for
    # ``(s)``, ObsessionDB keeps ``(s)``, so the parentheses around the whole
    # expression are not compared (#512). Inside the rendered parentheses
    # ``(a, b)`` and ``a, b`` are the same tuple, and ``((s))``, ``(s)`` and
    # ``s`` the same expression.
    data = index.model_dump(mode="json", by_alias=False)
    data["expression"] = sql_expression_fingerprint(index.expression)
    return json.dumps(data, sort_keys=True, default=str)


def _indexes_equal(left: SkipIndexDefinition, right: SkipIndexDefinition) -> bool:
    if left.type == "text" and right.type == "text":
        return text_index_fingerprint(left) == text_index_fingerprint(right)
    return _index_identity(left) == _index_identity(right)


def _is_comment_only_change(old: ColumnDefinition, new: ColumnDefinition) -> bool:
    old_data = _normalized_column(old)
    new_data = _normalized_column(new)
    old_data.pop("comment", None)
    new_data.pop("comment", None)
    return json.dumps(old_data, sort_keys=True, default=str) == json.dumps(
        new_data, sort_keys=True, default=str
    )


def _diff_comment(old: SchemaDefinition, new: SchemaDefinition) -> list[MigrationOperation]:
    """A comment change on a table, view, materialized view or dictionary.

    It is an ALTER of the object in place: recreating a materialized view would
    lose the rows its source receives in between.
    """
    if old.comment == new.comment:
        return []
    return [
        MigrationOperation(
            type="alter_table_modify_comment",
            key=f"{definition_key(new)}:comment",
            risk="safe",
            sql=render_alter_modify_comment(new),
        )
    ]


def _same_default(left: ColumnDefaultValue | None, right: ColumnDefaultValue | None) -> bool:
    """Mirror TS ``===``: Python treats ``0 == False`` and ``1 == True``."""
    return isinstance(left, bool) == isinstance(right, bool) and left == right


def _render_rename_column_suggestion_sql(
    table: TableDefinition, from_: str, to: str
) -> str:
    return (
        f"ALTER TABLE {render_qualified_name(table.database, table.name)} "
        f"RENAME COLUMN IF EXISTS {quote_identifier(from_)} TO {quote_identifier(to)};"
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
                sql=f"DROP TABLE IF EXISTS {render_qualified_name(new.database, new.name)} SYNC;",
            ),
            MigrationOperation(
                type="create_materialized_view",
                key=definition_key(new),
                risk="caution",
                sql=to_create_sql(new),
            ),
        ]

    refresh_ops = (
        [
            MigrationOperation(
                type="alter_materialized_view_modify_refresh",
                key=f"materialized_view:{new.database}.{new.name}:refresh",
                risk="caution",
                sql=render_alter_modify_refresh(new),
            )
        ]
        if has_new_refresh and not _refresh_equal(old.refresh, new.refresh)
        else []
    )
    return [*refresh_ops, *_diff_comment(old, new)]


def _recreate_drop_risk(old: TableDefinition) -> RiskLevel:
    """Distributed stores no rows, and DROP sends the inserts it still queues
    to the shards (flush_on_detach, on by default), so recreating one to change
    its engine arguments loses no data. Every other table loses its rows."""
    if not is_distributed_engine(old.engine):
        return "danger"
    flush_on_detach = (old.settings or {}).get("flush_on_detach")
    disabled = flush_on_detach is not None and js_trim(str(flush_on_detach)).lower() in (
        "0",
        "false",
    )
    return "danger" if disabled else "caution"


def _diff_tables(  # noqa: PLR0915 — mirrors TS diffTables
    old: TableDefinition, new: TableDefinition
) -> tuple[list[MigrationOperation], list[ColumnRenameSuggestion]]:
    if is_kafka_engine(old.engine) or is_kafka_engine(new.engine):
        old_settings = {
            key: kafka_setting_fingerprint(value) for key, value in (old.settings or {}).items()
        }
        new_settings = {
            key: kafka_setting_fingerprint(value) for key, value in (new.settings or {}).items()
        }
        old_columns = [(column.name, _column_identity(column)) for column in old.columns]
        new_columns = [(column.name, _column_identity(column)) for column in new.columns]
        if (
            _requires_table_recreate(old, new)
            or old_columns != new_columns
            or old_settings != new_settings
            or (old.comment or "") != (new.comment or "")
        ):
            raise ChxValidationError(
                [
                    ValidationIssue(
                        code="kafka_change_requires_replacement",
                        kind="table",
                        database=new.database,
                        name=new.name,
                        message=f"Kafka table {new.database}.{new.name} requires an explicit "
                        "replacement; column, engine and setting ALTERs are not supported. "
                        "Remove the queue and its consuming materialized views from the "
                        "schema and generate a drop migration, then re-add the updated "
                        "definitions and generate a create migration. Review "
                        "both migrations and consumer-group/offset behavior before applying with "
                        "--allow-destructive.",
                    )
                ]
            )
        return [], []
    if _requires_table_recreate(old, new):
        return (
            [
                MigrationOperation(
                    type="drop_table",
                    key=definition_key(new),
                    risk=_recreate_drop_risk(old),
                    sql=f"DROP TABLE IF EXISTS {render_qualified_name(new.database, new.name)};",
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
    # Report every blocked column of the table at once, not one per generate run.
    kind_change_issues: list[ValidationIssue] = []
    for column_change in column_diff.changed:
        old_kind = column_change.old_item.default_kind or "DEFAULT"
        new_kind = column_change.new_item.default_kind or "DEFAULT"
        if old_kind != new_kind and {old_kind, new_kind} & {"ALIAS", "EPHEMERAL"}:
            kind_change_issues.append(
                ValidationIssue(
                    code="column_kind_change_unsupported",
                    kind="table",
                    database=new.database,
                    name=new.name,
                    message=f"Cannot automatically change column {new.database}.{new.name}."
                    f"{column_change.name} from {old_kind} to {new_kind}; storage-kind "
                    "conversions involving ALIAS or EPHEMERAL are not supported. Keep the "
                    f"column declared as {old_kind} in the schema.",
                )
            )
    if kind_change_issues:
        raise ChxValidationError(kind_change_issues)
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
        old_kind = column_change.old_item.default_kind or "DEFAULT"
        new_kind = column_change.new_item.default_kind or "DEFAULT"
        key = f"table:{new.database}.{new.name}:column:{column_change.name}"
        remove_comment = (
            column_change.old_item.comment is not None and column_change.new_item.comment is None
        )
        if _is_comment_only_change(column_change.old_item, column_change.new_item):
            ops.append(
                MigrationOperation(
                    type="alter_table_modify_column",
                    key=key,
                    risk="safe",
                    sql=render_alter_remove_column_comment(new, column_change.name)
                    if remove_comment
                    else render_alter_comment_column(new, column_change.new_item),
                )
            )
            continue
        remove_expression = render_alter_remove_column_expression(
            new, column_change.new_item, column_change.old_item
        )
        # Its own operation: migrate pairs each `-- operation:` marker with exactly one statement.
        if remove_expression is not None:
            ops.append(
                MigrationOperation(
                    type="alter_table_modify_column", key=key, risk="caution", sql=remove_expression
                )
            )
        # MODIFY COLUMN without COMMENT keeps the old comment.
        if remove_comment:
            ops.append(
                MigrationOperation(
                    type="alter_table_modify_column",
                    key=key,
                    risk="safe",
                    sql=render_alter_remove_column_comment(new, column_change.name),
                )
            )
        # MODIFY COLUMN without a codec keeps the stored one: a removal is always
        # REMOVE CODEC, its own operation before any other change (#465).
        codec_removed = (
            column_change.old_item.codec is not None and column_change.new_item.codec is None
        )
        if codec_removed:
            ops.append(
                MigrationOperation(
                    type="alter_table_modify_column",
                    key=key,
                    risk="caution",
                    sql=render_alter_remove_codec(new, column_change.name),
                )
            )
        # The removals above already reach the schema when nothing else changed.
        if codec_removed and _column_identity_after_removals(
            column_change.old_item, remove_comment
        ) == _column_identity_after_removals(column_change.new_item, remove_comment):
            continue
        ops.append(
            MigrationOperation(
                type="alter_table_modify_column",
                key=key,
                risk="caution",
                sql=render_alter_modify_column(new, column_change.new_item),
                warning=(
                    f"Changing the expression for {new.database}.{new.name}.{column_change.name} "
                    "does not rewrite stored historical values. "
                    "Review a separate MATERIALIZE COLUMN "
                    "migration if a rewrite is required; never reconstruct values "
                    "from discarded EPHEMERAL inputs."
                    if {old_kind, new_kind} & {"DEFAULT", "MATERIALIZED"}
                    and (
                        not _same_default(
                            column_change.old_item.default, column_change.new_item.default
                        )
                        or old_kind != new_kind
                    )
                    else None
                ),
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

    ops.extend(_constraint_operations(old, new))

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
    ops.extend(_diff_comment(old, new))

    rename_suggestions = _infer_column_rename_suggestions(new, added_columns, dropped_columns)
    return ops, rename_suggestions


def _constraint_operations(old: TableDefinition, new: TableDefinition) -> list[MigrationOperation]:
    def key(name: str) -> str:
        return f"table:{new.database}.{new.name}:constraint:{name}"

    def add(constraint: TableConstraintDefinition) -> MigrationOperation:
        return MigrationOperation(
            type="alter_table_add_constraint",
            key=key(constraint.name),
            risk="caution",
            sql=render_alter_add_constraint(new, constraint),
            warning=_constraint_warning(new, constraint),
        )

    def drop(name: str) -> MigrationOperation:
        return MigrationOperation(
            type="alter_table_drop_constraint",
            key=key(name),
            risk="caution",
            sql=render_alter_drop_constraint(new, name),
        )

    diff = diff_by_name(
        list(old.constraints or []),
        list(new.constraints or []),
        lambda c: c.name,
        lambda left, right: left == right,
    )
    ops = [add(constraint) for constraint in diff.added]
    for change in diff.changed:
        ops += [drop(change.name), add(change.new_item)]
    ops += [drop(constraint.name) for constraint in diff.removed]
    return ops


def _constraint_warning(definition: TableDefinition, constraint: TableConstraintDefinition) -> str:
    subject = f"Constraint {constraint.name} on {definition.database}.{definition.name}"
    if constraint_kind(constraint) == "CHECK":
        return (
            f"{subject} applies to new INSERTs only: ClickHouse does not validate existing "
            "rows, and INSERTs with a row that fails the CHECK are rejected. Make sure every "
            "writer produces valid rows before applying."
        )
    return (
        f"{subject} is an ASSUME constraint: ClickHouse never validates it, and queries "
        "optimized with optimize_using_constraints trust it, so an assumption that does "
        "not hold returns wrong results."
    )


# Skip indexes, constraints and projections that read a column block its DROP
# COLUMN (and a changed column's MODIFY), so their drops run before every other
# ALTER. Their adds keep key order, which puts them after the column ALTERs.
_DEPENDENT_DROPS = frozenset(
    {"alter_table_drop_index", "alter_table_drop_constraint", "alter_table_drop_projection"}
)


def _alter_rank(op: MigrationOperation) -> int:
    return 0 if op.type in _DEPENDENT_DROPS else 1


def _rank(op: MigrationOperation) -> int:
    # drop_* 0, alter_* 1, create_database 2, create_table 3, create_view 4, other creates 5.
    t = op.type
    if t.startswith("drop_"):
        return 0
    if t.startswith("alter_"):
        return 1
    if t == "create_database":
        return 2
    if t == "create_table":
        return 3
    if t == "create_view":
        return 4
    return 5


def _order_operations(
    ordered: list[MigrationOperation],
    *,
    drop: DependencyGraph,
    create: DependencyGraph,
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
) -> list[MigrationOperation]:
    """Reorder the drop and create segments of a (rank, key)-sorted plan by object dependencies.

    Drops run dependents first, creates run dependencies first (#231). Alters
    and create_database keep their place, except that the column statements
    of a table are ordered by the columns they read and remove.
    """
    drops = [op for op in ordered if _rank(op) == 0]
    middle = [op for op in ordered if _rank(op) in (1, 2)]
    creates = [op for op in ordered if _rank(op) >= 3]  # noqa: PLR2004
    return [
        *order_by_dependencies(drops, lambda op: op.key, lambda key: drop.get(key, ())),
        *order_column_statements(middle, previous=previous, next_=next_, renames=()),
        *order_by_dependencies(creates, lambda op: op.key, lambda key: create.get(key, ())),
    ]


# The table TTL statement (MODIFY or REMOVE TTL) sorts with the column
# statements: it reads columns that are added and dropped (#769).
_COLUMN_STATEMENTS = frozenset(
    {
        "alter_table_add_column",
        "alter_table_modify_column",
        "alter_table_drop_column",
        "alter_table_rename_column",
        "alter_table_modify_ttl",
    }
)


def is_column_statement(op: MigrationOperation) -> bool:
    return op.type in _COLUMN_STATEMENTS


def column_rename_key(rename: ColumnRenameSuggestion) -> str:
    """Key of the RENAME COLUMN operation of ``rename``."""
    return f"table:{rename.database}.{rename.table}:column_rename:{rename.from_}:{rename.to}"


def order_column_statements(
    operations: Sequence[MigrationOperation],
    *,
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
    renames: Sequence[ColumnRenameSuggestion],
) -> list[MigrationOperation]:
    """Order the column and TTL statements of every table in one sort (TS orderColumnStatements).

    The statements are ADD, MODIFY, DROP and RENAME COLUMN and the table TTL
    statement, from their key order (#681, #745, #746, #758, #769, #775):

    - an ADD or MODIFY whose new DEFAULT, MATERIALIZED or ALIAS expression, or
      a table TTL that reads column X runs after the ADD of X or the RENAME to X;
    - a DROP of X runs after the MODIFY or DROP of every column whose old
      expression reads X, and after the TTL change when the old TTL reads X,
      since ClickHouse refuses to drop a column something still reads. A
      RENAME away from X needs no such wait: ClickHouse rewrites the
      expressions and the TTL that read X to the new name;
    - a MODIFY whose new expression would close a cycle with an old
      expression runs after the MODIFY that removes that old read
      (``_cycle_releases``);
    - when the order still closes a cycle in a table whose reads are certain
      (``_repaired_order``), the first breaker in key order runs before the
      MODIFY that closes it (``_break_closed_cycles``, #775);
    - statements of the same column keep their order.

    Members of a cycle keep their key order. The statements fill the positions
    the column statements had, so every other operation keeps its place, and
    a table's statements never move past another table's (they share no
    edge). ``renames`` names the columns of each RENAME COLUMN in ``operations``.
    """
    reads = _column_default_reads(next_)
    old_reads = _column_default_reads(previous)
    ttl_reads = _table_ttl_reads(next_)
    old_ttl_reads = _table_ttl_reads(previous)
    renamed_to = {
        column_rename_key(rename): _column_key(rename.database, rename.table, rename.to)
        for rename in renames
    }
    statements = sorted((op for op in operations if is_column_statement(op)), key=lambda op: op.key)

    providers: dict[str, list[int]] = {}
    releasers: dict[str, list[int]] = {}
    modifies: dict[str, list[int]] = {}
    for index, op in enumerate(statements):
        if op.type == "alter_table_add_column":
            providers.setdefault(op.key, []).append(index)
        renamed = renamed_to.get(op.key)
        if op.type == "alter_table_rename_column" and renamed is not None:
            providers.setdefault(renamed, []).append(index)
        if op.type == "alter_table_modify_column":
            modifies.setdefault(op.key, []).append(index)
        if op.type in ("alter_table_modify_column", "alter_table_drop_column"):
            for read in old_reads.get(op.key, ()):
                releasers.setdefault(read, []).append(index)
        if op.type == "alter_table_modify_ttl":
            for read in old_ttl_reads.get(op.key, ()):
                releasers.setdefault(read, []).append(index)

    added = {op.key for op in statements if op.type == "alter_table_add_column"}
    prerequisites: list[list[int]] = []
    for index, op in enumerate(statements):
        found: dict[int, None] = {}
        if op.type in ("alter_table_add_column", "alter_table_modify_column"):
            for read in reads.get(op.key, ()):
                for other in providers.get(read, []):
                    found[other] = None
        if op.type == "alter_table_modify_ttl":
            for read in ttl_reads.get(op.key, ()):
                for other in providers.get(read, []):
                    found[other] = None
        if op.type == "alter_table_drop_column":
            for other in releasers.get(op.key, []):
                found[other] = None
        # A column's last statement is the MODIFY COLUMN that sets its new expression.
        is_last = index + 1 == len(statements) or statements[index + 1].key != op.key
        if op.type == "alter_table_modify_column" and is_last:
            for column in _cycle_releases(op.key, reads, old_reads, added):
                for other in modifies.get(column, []):
                    found[other] = None
        if index > 0 and statements[index - 1].key == op.key:
            found[index - 1] = None
        found.pop(index, None)
        prerequisites.append(list(found))

    ordered = iter(
        _repaired_order(
            prerequisites,
            statements,
            previous=previous,
            next_=next_,
            renames=renames,
        )
    )
    return [statements[next(ordered)] if is_column_statement(op) else op for op in operations]


class _CycleRepairWork:
    """The units of work the cycle repair did in the last ``order_column_statements``.

    The same in both ports, for tests that bound it.
    """

    units = 0


_cycle_repair_work = _CycleRepairWork()


def _repaired_order(  # noqa: PLR0915
    prerequisites: list[list[int]],
    statements: Sequence[MigrationOperation],
    *,
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
    renames: Sequence[ColumnRenameSuggestion],
) -> list[int]:
    """The sorted order, with the temporary default cycles it closes broken where reads are certain.

    #775. Each table is replayed on its own, with its own work budget, and
    gives only edges that make a closing statement wait for a breaker
    (``_break_closed_cycles``); one more sort with those edges gives the
    order. A table is left out, and keeps its sorted order, when it has a
    RENAME COLUMN in ``renames`` (the replay does not rename), when one of its
    expressions is not plain (``_plain_reads``), when a statement's key could
    be one of its columns or another table's, when a prerequisite links its
    statements to another table's (keys of two tables can be the same), when
    no statement can break its cycle, or when its replay runs out of work.
    Only the columns that ``_cycle_candidates`` finds take part.
    """
    _cycle_repair_work.units = 0
    # Every search below walks prerequisites in index order, so the work it
    # does, and where the budget ends, is the same in both ports.
    prerequisites = [sorted(before) for before in prerequisites]
    sorted_order = order_by_dependencies(
        list(range(len(statements))),
        str,
        lambda key: [str(other) for other in prerequisites[int(key)]],
    )
    columns, ambiguous = _statement_columns(statements, previous, next_)
    excluded = set(ambiguous)
    for rename in renames:
        excluded.add(_table_id(rename.database, rename.table))
    # Statements connected through prerequisites. A connection to another
    # table's statement, or to a statement of no known table, leaves the
    # tables out: the repair must not move a statement of a table that keeps
    # its sorted order.
    component = _connected_statements(prerequisites)
    owners = _statement_tables(statements, columns, previous, next_, renames)
    tables_of: dict[int, set[str | None]] = {}
    for index, root in enumerate(component):
        tables_of.setdefault(root, set()).add(owners[index])
    for tables in tables_of.values():
        if len(tables) > 1:
            excluded.update(table for table in tables if table is not None)
    # Only a table with a column statement can close a cycle while the plan runs.
    active = dict.fromkeys(
        column.table for column in columns if column is not None and column.table not in excluded
    )
    if not active:
        return sorted_order
    old_plain, old_uncertain = _plain_facts(previous, active)
    new_plain, new_uncertain = _plain_facts(next_, active)
    for table in old_uncertain | new_uncertain:
        active.pop(table, None)
    # Per table: the columns that may close a cycle, the size of its replay
    # (those columns and all their reads) and its old expressions.
    candidates: dict[str, set[str]] = {}
    size: dict[str, int] = {}
    initial: dict[str, list[tuple[str, set[str]]]] = {}
    for table in active:
        graphs = [
            graph for graph in (old_plain.get(table), new_plain.get(table)) if graph is not None
        ]
        found = _cycle_candidates(graphs)
        if not found:
            continue
        candidates[table] = found
        total = len(found)
        for graph in graphs:
            for column_id, reads in graph.items():
                if column_id in found:
                    total += len(reads)
        size[table] = total
        initial[table] = [
            (column_id, reads)
            for column_id, reads in old_plain.get(table, {}).items()
            if column_id in found
        ]
    # The statements each table replays.
    replayed: dict[str, list[int]] = {}
    ids = [column.id if column is not None else None for column in columns]
    for index in sorted_order:
        column = columns[index]
        if column is None or column.id not in candidates.get(column.table, ()):
            continue
        replayed.setdefault(column.table, []).append(index)
    if not replayed:
        return sorted_order
    changes = _replay_changes(statements, columns, new_plain)
    groups = [sorted(members) for members in strongly_connected_components(prerequisites)]
    group_of = [0] * len(prerequisites)
    for group, members in enumerate(groups):
        for member in members:
            group_of[member] = group
    connected: dict[int, list[int]] = {}
    for index, root in enumerate(component):
        connected.setdefault(root, []).append(index)
    added: list[tuple[int, int]] = []
    for table, members in replayed.items():
        roots = dict.fromkeys(component[index] for index in members)
        scheduled = sorted(index for root in roots for index in connected[root])
        # The budget also covers the prerequisites the breaker checks walk.
        total = size.get(table, 0) + sum(len(prerequisites[index]) for index in scheduled)
        replay = _DefaultReplay(initial.get(table, []), 8 * total + 1024)
        edges = _break_closed_cycles(
            scheduled,
            set(members),
            statements=statements,
            prerequisites=prerequisites,
            groups=groups,
            group_of=group_of,
            columns=ids,
            changes=changes,
            replay=replay,
        )
        _cycle_repair_work.units += replay.used()
        if edges is not None:
            added.extend(edges)
    if not added:
        return sorted_order
    extended = [list(before) for before in prerequisites]
    for target, breaker in added:
        extended[target].append(breaker)
    return _group_order(extended, groups, group_of)


def _group_order(
    prerequisites: list[list[int]], groups: list[list[int]], group_of: list[int]
) -> list[int]:
    """The order ``order_by_dependencies`` gives ``prerequisites`` whose cycles are ``groups``.

    The ready group whose first statement comes first runs next, its members
    in key order. A heap of ready groups keeps it near linear.
    """
    remaining = [0] * len(groups)
    dependents: list[list[int]] = [[] for _ in prerequisites]
    for index, before in enumerate(prerequisites):
        for other in before:
            if group_of[other] == group_of[index]:
                continue
            remaining[group_of[index]] += 1
            dependents[other].append(index)
    ready = [(groups[group][0], group) for group in range(len(groups)) if remaining[group] == 0]
    heapq.heapify(ready)
    order: list[int] = []
    while ready:
        _, group = heapq.heappop(ready)
        order.extend(groups[group])
        for member in groups[group]:
            for other in dependents[member]:
                remaining[group_of[other]] -= 1
                if remaining[group_of[other]] == 0:
                    heapq.heappush(ready, (groups[group_of[other]][0], group_of[other]))
    return order


def _break_closed_cycles(  # noqa: PLR0915
    scheduled: list[int],
    replayed: set[int],
    *,
    statements: Sequence[MigrationOperation],
    prerequisites: list[list[int]],
    groups: list[list[int]],
    group_of: list[int],
    columns: list[str | None],
    changes: dict[int, set[str]],
    replay: _DefaultReplay,
) -> list[tuple[int, int]] | None:
    """The edges that make each statement of ``scheduled`` that would close a cycle wait (#775).

    ``_cycle_releases`` adds an edge only when one MODIFY must break the
    cycle in every order. When several could, or the cycle closes through two
    new expressions, this sorts ``scheduled`` (whole groups of connected
    statements) like ``order_by_dependencies`` while replaying the
    ``replayed`` ones: the ready group with the lowest key order runs next, a
    group being one statement or the members of a cycle among the
    prerequisites, in key order. A statement that would close a cycle makes
    its group wait for the breaker with the lowest key order: a later
    statement of a column on the cycle whose change removes a read on it, and
    the group's statements are replayed back. A breaker that already waits for
    the statement is skipped, so the edges never form a new cycle. The groups
    before it keep their places, so this is the order that adding the edge and
    sorting again would give. With no breaker, or when the replay runs out of
    work, it returns None.
    """
    added: list[tuple[int, int]] = []
    extra: dict[int, list[int]] = {}
    # The statements that change each column's expression, in key order.
    changing: dict[str, list[int]] = {}
    for index in scheduled:
        column = columns[index]
        if column is not None and index in replayed and index in changes:
            changing.setdefault(column, []).append(index)
    # A group runs once every prerequisite of its members outside it has run.
    remaining: dict[int, int] = {}
    dependents: dict[int, list[int]] = {}

    def wait(index: int, other: int) -> None:
        if group_of[other] == group_of[index]:
            return
        remaining[group_of[index]] = remaining.get(group_of[index], 0) + 1
        dependents.setdefault(other, []).append(index)

    own_groups: dict[int, None] = {}
    for index in scheduled:
        own_groups[group_of[index]] = None
        for other in prerequisites[index]:
            wait(index, other)
    placed: set[int] = set()
    ready = [(groups[group][0], group) for group in own_groups if remaining.get(group, 0) == 0]
    heapq.heapify(ready)
    while ready:
        _, group = heapq.heappop(ready)
        # A group is looked at again each time a breaker blocks it.
        if not replay.spend(len(groups[group])):
            return None
        undo: list[tuple[str, list[str] | None]] = []
        blocked = False
        for target in groups[group]:
            column = columns[target]
            if column is None or target not in replayed:
                continue
            change = changes.get(target)
            cycle = replay.closed_cycle(column, change) if change is not None else set()
            if cycle is None:
                return None
            if cycle:
                candidates = sorted(
                    j
                    for other in cycle
                    if other != column
                    for j in changing.get(other, ())
                    if j not in placed and group_of[j] != group
                )
                if not replay.spend(len(cycle) + len(candidates)):
                    return None
                breaker: int | None = None
                for j in candidates:
                    if not any(
                        read in cycle and read not in changes[j]
                        for read in replay.reads(columns[j] or "") or ()
                    ):
                        continue
                    waits = _waits_for(
                        prerequisites, extra, j, target, placed=placed, replay=replay
                    )
                    if waits is None:
                        return None
                    if not waits:
                        breaker = j
                        break
                if breaker is None:
                    return None
                for undone, reads in reversed(undo):
                    replay.assign(undone, reads)
                if replay.exhausted():
                    return None
                added.append((target, breaker))
                extra.setdefault(target, []).append(breaker)
                wait(target, breaker)
                blocked = True
                break
            undo.append((column, replay.reads(column)))
            # A DROP removes its column; a change sets its reads.
            if statements[target].type == "alter_table_drop_column":
                replay.assign(column, None)
            if change is not None:
                replay.assign(column, change)
            if replay.exhausted():
                return None
        if blocked:
            continue
        placed.update(groups[group])
        for member in groups[group]:
            for other in dependents.get(member, ()):
                remaining[group_of[other]] -= 1
                if remaining[group_of[other]] == 0:
                    heapq.heappush(ready, (groups[group_of[other]][0], group_of[other]))
    return added


def _waits_for(
    prerequisites: list[list[int]],
    extra: dict[int, list[int]],
    start: int,
    target: int,
    *,
    placed: set[int],
    replay: _DefaultReplay,
) -> bool | None:
    """Whether statement ``start`` runs after ``target`` through ``prerequisites`` and ``extra``.

    None when ``replay`` runs out of work. A ``placed`` statement has run, so
    it does not wait for ``target``, which has not. Each prerequisite it looks
    at uses one unit of the replay's work.
    """
    seen = {start}
    pending = [start]
    while pending:
        index = pending.pop()
        for others in (prerequisites[index], extra.get(index, ())):
            for other in others:
                if not replay.spend():
                    return None
                if other == target:
                    return True
                if other in placed or other in seen:
                    continue
                seen.add(other)
                pending.append(other)
    return False


def _connected_statements(prerequisites: list[list[int]]) -> list[int]:
    """Statement index to a statement it is connected to through prerequisites, the same for all."""
    parent = list(range(len(prerequisites)))

    def find(index: int) -> int:
        root = index
        while parent[root] != root:
            root = parent[root]
        while parent[index] != root:
            parent[index], index = root, parent[index]
        return root

    for index, before in enumerate(prerequisites):
        for other in before:
            a, b = find(index), find(other)
            if a != b:
                parent[max(a, b)] = min(a, b)
    return [find(index) for index in range(len(prerequisites))]


def _statement_tables(
    statements: Sequence[MigrationOperation],
    columns: list[_StatementColumn | None],
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
    renames: Sequence[ColumnRenameSuggestion],
) -> list[str | None]:
    """The ``_table_id`` of each statement.

    Its column's table (``_statement_columns``), the table of a table TTL
    statement or of a RENAME COLUMN in ``renames``, or None when no single
    table owns its key.
    """
    owners: dict[str, str | None] = {}

    def own(key: str, table: str) -> None:
        owners[key] = None if key in owners and owners[key] != table else table

    for definition in [*previous, *next_]:
        if isinstance(definition, TableDefinition):
            own(
                f"table:{definition.database}.{definition.name}:ttl",
                _table_id(definition.database, definition.name),
            )
    for rename in renames:
        own(column_rename_key(rename), _table_id(rename.database, rename.table))
    return [
        column.table if column is not None else owners.get(op.key)
        for op, column in zip(statements, columns, strict=True)
    ]


class _StatementColumn:
    """The column a statement changes, as it was and as it will be."""

    __slots__ = ("after", "before", "id", "table")

    def __init__(self, column_id: str, table: str) -> None:
        self.id = column_id
        self.table = table
        self.before: ColumnDefinition | None = None
        self.after: ColumnDefinition | None = None


def _statement_columns(
    statements: Sequence[MigrationOperation],
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
) -> tuple[list[_StatementColumn | None], set[str]]:
    """The column (``_column_id``) of each ADD, MODIFY and DROP COLUMN statement.

    A key can name the columns of two tables (table ``t:column:x`` and column
    ``x:column:a`` of ``t`` give the same key); the statement then belongs to
    the one whose column it changes: added, dropped or changed. When that is
    still more than one, the tables are ambiguous and the repair leaves them
    out.
    """
    # Only the keys of the statements matter.
    keys = {op.key for op in statements}
    by_key: dict[str, list[_StatementColumn]] = {}

    def record(definitions: Sequence[SchemaDefinition], *, before: bool) -> None:
        for definition in definitions:
            if not isinstance(definition, TableDefinition):
                continue
            table = _table_id(definition.database, definition.name)
            prefix = _column_key(definition.database, definition.name, "")
            for column in definition.columns:
                key = prefix + column.name
                if key not in keys:
                    continue
                column_id = f"{table}\x00{column.name}"
                entries = by_key.setdefault(key, [])
                entry = next((found for found in entries if found.id == column_id), None)
                if entry is None:
                    entry = _StatementColumn(column_id, table)
                    entries.append(entry)
                if before:
                    entry.before = column
                else:
                    entry.after = column

    record(previous, before=True)
    record(next_, before=False)
    ambiguous: set[str] = set()
    found_columns: list[_StatementColumn | None] = []
    for op in statements:
        if op.type not in (
            "alter_table_add_column",
            "alter_table_modify_column",
            "alter_table_drop_column",
        ):
            found_columns.append(None)
            continue
        entries = by_key.get(op.key, [])
        # A key that names one column is that column's.
        if len(entries) <= 1:
            found_columns.append(entries[0] if entries else None)
            continue
        matching = []
        for entry in entries:
            old, new = entry.before, entry.after
            if op.type == "alter_table_add_column":
                matches = old is None and new is not None
            elif op.type == "alter_table_drop_column":
                matches = old is not None and new is None
            else:
                matches = old is not None and new is not None and not _columns_equal(old, new)
            if matches:
                matching.append(entry)
        if len(matching) == 1:
            found_columns.append(matching[0])
            continue
        ambiguous.update(entry.table for entry in entries)
        found_columns.append(None)
    return found_columns, ambiguous


def _replay_changes(
    statements: Sequence[MigrationOperation],
    columns: list[_StatementColumn | None],
    plain: dict[str, dict[str, set[str]]],
) -> dict[int, set[str]]:
    """Statement index to the plain reads (as ``_column_id``) of its column's expression after it.

    Only for the statements that set an expression: an ADD, a column's last
    MODIFY (which sets the new expression or keeps none), and the REMOVE
    DEFAULT, MATERIALIZED or ALIAS that runs first when the new column has no
    expression (``render_alter_remove_column_expression``). The other
    statements (REMOVE COMMENT, REMOVE CODEC) keep it.
    """
    changes: dict[int, set[str]] = {}
    for index, op in enumerate(statements):
        column = columns[index]
        if column is None:
            continue
        previous_column = columns[index - 1] if index > 0 else None
        next_column = columns[index + 1] if index + 1 < len(columns) else None
        first = previous_column is None or previous_column.id != column.id
        last = next_column is None or next_column.id != column.id
        is_modify = op.type == "alter_table_modify_column"
        before, after = column.before, column.after
        removed = (
            before is not None
            and before.default is not None
            and after is not None
            and after.default is None
            and after.default_kind != "EPHEMERAL"
        )
        if op.type == "alter_table_add_column" or (is_modify and last):
            changes[index] = plain.get(column.table, {}).get(column.id, set())
        elif is_modify and first and removed:
            changes[index] = set()
    return changes


class _DefaultReplay:
    """The replay of one table, from its ``initial`` (old) expressions.

    Its state never holds a cycle, so a new read Y of column X closes one
    exactly when Y reaches X. That search runs from both ends at once,
    widening the smaller frontier (in turns on a tie), so it stops early when
    either side runs out. Columns are numbered in the order the replay first
    meets them (each set in code point order); reads are kept in that order
    and readers in the order they were added, so every search does the same
    work in both ports. Each read a search, an update or a copy looks at uses
    one unit of the ``budget``.
    """

    def __init__(self, initial: list[tuple[str, set[str]]], budget: int) -> None:
        self._number: dict[str, int] = {}
        self._names: list[str] = []
        self._reads: list[list[int] | None] = []
        self._readers: list[dict[int, None]] = []
        # Marks with an epoch per search, instead of a set per search.
        self._down: list[int] = []
        self._up: list[int] = []
        self._inside: list[int] = []
        self._epoch = 0
        self._left = budget
        for column, reads in initial:
            self.assign(column, reads)
        self._budget = budget

    def spend(self, units: int = 1) -> bool:
        """Use ``units`` of work; False once the work has run out."""
        self._left -= units
        return self._left >= 0

    def exhausted(self) -> bool:
        """Whether the work has run out."""
        return self._left < 0

    def used(self) -> int:
        """The units of work used so far."""
        return self._budget - max(self._left, 0)

    def _of(self, column: str) -> int:
        known = self._number.get(column)
        if known is not None:
            return known
        number = len(self._names)
        self._number[column] = number
        self._names.append(column)
        self._reads.append(None)
        self._readers.append({})
        self._down.append(0)
        self._up.append(0)
        self._inside.append(0)
        return number

    def _numbered(self, columns: Iterable[str]) -> list[int]:
        # Columns are numbered in code point order within each set, so both ports number them alike.
        ordered = sorted(columns)
        self._left -= len(ordered)
        return sorted(self._of(column) for column in ordered)

    def reads(self, column: str) -> list[str] | None:
        """The columns ``column`` reads."""
        number = self._number.get(column)
        if number is None:
            return None
        reads = self._reads[number]
        self._left -= len(reads or ())
        return None if reads is None else [self._names[read] for read in reads]

    def assign(self, column: str, reads: Iterable[str] | None) -> None:
        """Give ``column`` the ``reads`` (none removes it); they must close no cycle."""
        # Every read a step looks at uses one unit of the budget.
        number = self._of(column)
        old = self._reads[number] or ()
        self._left -= len(old)
        for read in old:
            self._readers[read].pop(number, None)
        numbered = None if reads is None else self._numbered(reads)
        self._reads[number] = numbered
        for read in numbered or ():
            self._readers[read][number] = None

    def closed_cycle(self, column: str, reads: set[str]) -> set[str] | None:
        """The columns on a cycle through ``column`` that giving it ``reads`` would close.

        It changes nothing, and returns None when the replay has used up its
        work.
        """
        target = self._of(column)
        current = set(self._reads[target] or ())
        self._left -= len(current)
        cycle: set[str] = set()
        down, inside = self._down, self._inside
        numbered = self._numbered(reads)
        if self._left < 0:
            return None
        for read in numbered:
            if read in current:
                continue
            hit = self._reaches(read, target)
            if hit is None:
                return None
            if not hit:
                continue
            # This read's cycle: the columns it reaches (``down``) that reach ``column``.
            self._epoch += 1
            epoch = self._epoch
            below = [read]
            down[read] = epoch
            while below:
                for other in self._reads[below.pop()] or ():
                    self._left -= 1
                    if self._left < 0:
                        return None
                    if other == target or down[other] == epoch:
                        continue
                    down[other] = epoch
                    below.append(other)
            down[target] = epoch
            back = [target]
            inside[target] = epoch
            cycle.add(column)
            while back:
                for reader in self._readers[back.pop()]:
                    self._left -= 1
                    if self._left < 0:
                        return None
                    if down[reader] != epoch or inside[reader] == epoch:
                        continue
                    inside[reader] = epoch
                    cycle.add(self._names[reader])
                    back.append(reader)
        return cycle

    def _reaches(self, start: int, goal: int) -> bool | None:
        """Whether ``start`` reaches ``goal`` through reads, or None when the work runs out."""
        self._epoch += 1
        epoch = self._epoch
        down, up = self._down, self._up
        down[start] = epoch
        up[goal] = epoch
        down_front, up_front = [start], [goal]
        widen_down = False
        while down_front and up_front:
            # The smaller frontier widens; on a tie, the sides take turns.
            if len(down_front) == len(up_front):
                widen_down = not widen_down
            else:
                widen_down = len(down_front) < len(up_front)
            front: list[int] = []
            if widen_down:
                for column in down_front:
                    for reached in self._reads[column] or ():
                        self._left -= 1
                        if self._left < 0:
                            return None
                        if up[reached] == epoch:
                            return True
                        if down[reached] != epoch:
                            down[reached] = epoch
                            front.append(reached)
                down_front = front
            else:
                for column in up_front:
                    for reached in self._readers[column]:
                        self._left -= 1
                        if self._left < 0:
                            return None
                        if down[reached] == epoch:
                            return True
                        if up[reached] != epoch:
                            up[reached] = epoch
                            front.append(reached)
                up_front = front
        return False


def _table_id(database: str, table: str) -> str:
    """The identity of a table: its database and name, which a column key does not carry."""
    return f"{database}\x00{table}"


def _cycle_candidates(graphs: list[dict[str, set[str]]]) -> set[str]:
    """The columns that may lie on a cycle of the union of one table's ``graphs``.

    What is left after removing, again and again, the columns that read
    nothing or that nothing reads among the columns left. With no cycle
    nothing is left, so a table whose old and new reads form no cycle is not
    replayed at all. A read in both graphs counts twice, on both ends.
    """
    out: dict[str, list[str]] = {}
    into: dict[str, list[str]] = {}
    for graph in graphs:
        for column, reads in graph.items():
            if not reads:
                continue
            out.setdefault(column, []).extend(reads)
            for read in reads:
                into.setdefault(read, []).append(column)
    out_degree: dict[str, int] = {}
    in_degree: dict[str, int] = {}
    pending: list[str] = []
    for column in {**dict.fromkeys(out), **dict.fromkeys(into)}:
        reads_count = len(out.get(column, ()))
        readers_count = len(into.get(column, ()))
        out_degree[column] = reads_count
        in_degree[column] = readers_count
        if reads_count == 0 or readers_count == 0:
            pending.append(column)
    removed = set(pending)

    def lower(degree: dict[str, int], column: str) -> None:
        if column in removed:
            return
        degree[column] -= 1
        if degree[column] > 0:
            return
        removed.add(column)
        pending.append(column)

    while pending:
        column = pending.pop()
        for read in out.get(column, ()):
            lower(in_degree, read)
        for reader in into.get(column, ()):
            lower(out_degree, reader)
    return set(out_degree) - removed


_BINARY_OPERATORS = frozenset(["+", "-", "*", "/", "%", "=", "<", ">"])
_PAIRED_OPERATORS = frozenset(["<=", ">=", "!=", "<>", "==", "||"])
# Bare words ClickHouse reads as literals (any case), whatever the columns.
_LITERAL_WORDS = frozenset(["false", "inf", "infinity", "nan", "null", "true"])
# Bare words that are not function names even before ``(``. ClickHouse 26.8
# reads ``(values(c))`` as a subquery over SQL-standard VALUES.
_NOT_FUNCTIONS = frozenset(["exists", "lambda", "select", "values", "with"])
# Keywords of ClickHouse's expression grammar (operators, literals and the
# words of CASE, INTERVAL, DATE, CAST, EXTRACT, subqueries and windows): a
# bare one may not read a column of that name, so its expression is not
# plain, and neither is a call to one outside ``_KEYWORD_FUNCTIONS``. A quoted
# name reads such a column. Query clause and join words (``left``, ``right``,
# ``format``, ``values``, ``offset``, ``settings``...) are not here: ClickHouse
# 26.3 reads a bare one as its column and a call to one as a function, and
# their clause uses (``... FORMAT JSON``, ``LIMIT 1 OFFSET 2``) follow an
# operand, which is not plain anyway.
_EXPRESSION_KEYWORDS = frozenset(
    [
        "all", "and", "any", "array", "as", "asc", "ascending", "between", "both", "by",
        "case", "cast", "collate", "columns", "current", "date", "desc", "descending",
        "distinct", "div", "else", "end", "escape", "except", "exists", "extract", "filter",
        "first", "following", "for", "from", "global", "ignore", "ilike", "in", "interval",
        "is", "lambda", "last", "leading", "like", "mod", "not", "nulls", "or", "order",
        "over", "partition", "position", "preceding", "range", "regexp", "replace",
        "respect", "row", "rows", "select", "substring", "then", "ties", "timestamp",
        "trailing", "trim", "unbounded", "when", "where", "window", "with", "within",
    ]
)
# Keywords that are also ordinary functions when called: their special forms
# (``substring(s FROM 1)``, ``trim(BOTH ...)``) put keywords inside, which are
# not plain anyway.
_KEYWORD_FUNCTIONS = frozenset(
    ["array", "ilike", "like", "mod", "not", "position", "range", "replace", "substring", "trim"]
)
# Functions whose arguments can be units or keywords (``date_add(day, 1, ts)``,
# ``dateDiff(hour, a, b)``, ``EXTRACT(day FROM ts)``): a call to one, in any
# case and with any arguments, is not plain.
_SPECIAL_ARGUMENT_FUNCTIONS = frozenset(
    [
        "date_add", "date_diff", "date_part", "date_sub", "date_trunc", "dateadd", "datediff",
        "datepart", "datesub", "datetrunc", "extract", "timestamp_add", "timestamp_diff",
        "timestamp_sub", "timestampadd", "timestampdiff", "timestampsub",
    ]
)
# Deeper types than this are not parsed: the expression is not plain.
_TYPE_DEPTH = 32


def _plain_reads(tokens: list[SQLToken], columns: set[str]) -> list[str] | None:  # noqa: PLR0915
    """The columns an expression reads when its reads are certain (#775), or None.

    It must be built only from ``columns``, function calls (a bare name
    followed by ``(``, other than ``_SPECIAL_ARGUMENT_FUNCTIONS``), number and
    string literals (with ``x'…'`` and
    ``b'…'``, and the bare words NULL, TRUE, FALSE, inf, nan and infinity,
    which never read a column), unary ``-``, ``+`` and NOT, binary operators
    (AND and OR as well, unless a column has that name), parentheses, commas
    between call arguments, and the casts ``CAST(x AS T)`` and ``x::T`` with a
    type ``_parse_type`` accepts. Anything else, such as another keyword or
    name, two operands in a row (``date '2024-01-01'``, ``INTERVAL 1 day``,
    ``x alias``), ``.``, brackets, a lambda, a subquery or any other AS, is
    not, and its table keeps its sorted order. A quoted name only reads a
    column, and a quoted literal word other than ``null`` is not plain.
    ``tokens`` have no trivia.
    """
    count = len(tokens)
    reads: list[str] = []
    frames: list[str] = []

    def text_at(i: int) -> str | None:
        return tokens[i].text if 0 <= i < count else None

    def adjacent(i: int, text: str | None = None) -> bool:
        if i + 1 >= count or tokens[i + 1].start != tokens[i].end:
            return False
        return text is None or tokens[i + 1].text == text

    operand = True
    i = 0
    while i < count:
        token = tokens[i]
        text = token.text
        word = text.lower() if token.kind == "identifier" else None
        if operand:
            if token.kind in ("number", "string"):
                operand = False
            elif (
                word in ("x", "b")
                and i + 1 < count
                and tokens[i + 1].kind == "string"
                and adjacent(i)
            ):
                i += 1
                operand = False
            elif word is not None and word in _LITERAL_WORDS:
                operand = False
            elif word is not None and text_at(i + 1) == "(":
                if word in _NOT_FUNCTIONS or word in _SPECIAL_ARGUMENT_FUNCTIONS:
                    return None
                if (
                    word in _EXPRESSION_KEYWORDS
                    and word != "cast"
                    and word not in _KEYWORD_FUNCTIONS
                ):
                    return None
                i += 1
                if text_at(i + 1) == ")":
                    i += 1
                    operand = False
                else:
                    frames.append("cast" if word == "cast" else "call")
            elif word == "not" and text not in columns:
                pass  # Unary NOT; the operand follows.
            elif word is not None and word in _EXPRESSION_KEYWORDS:
                return None
            elif token.kind in ("identifier", "quoted_identifier"):
                name = identifier_name(token)
                if name is None or name not in columns:
                    return None
                # A quoted ``true``, ``false``, ``inf``, ``nan`` or ``infinity``
                # reads its column when ClickHouse creates the table or computes
                # the default, but ALTER's cycle check reads it as a literal.
                # ClickHouse stores a quoted ``not`` followed by an operand as
                # NOT, so its check sees no read either. Only ``null`` reads its
                # column in both.
                lower = name.lower()
                if lower == "not" or (lower != "null" and lower in _LITERAL_WORDS):
                    return None
                reads.append(name)
                operand = False
            elif text == "(":
                frames.append("group")
            elif text not in ("-", "+"):
                return None
            i += 1
            continue
        if text == ")":
            if not frames:
                return None
            frames.pop()
        elif text == ",":
            if not frames or frames[-1] == "group":
                return None
            frames[-1] = "call"
            operand = True
        elif word == "as" and frames and frames[-1] == "cast":
            end = _parse_type(tokens, i + 1)
            if end == -1 or text_at(end) != ")":
                return None
            i = end
            frames.pop()
        elif word in ("and", "or") and text not in columns:
            operand = True
        elif text == ":" and adjacent(i, ":"):
            end = _parse_type(tokens, i + 2)
            if end == -1:
                return None
            i = end - 1
        elif (
            token.kind == "punctuation"
            and text + (text_at(i + 1) or "") in _PAIRED_OPERATORS
            and adjacent(i)
        ):
            i += 1
            operand = True
        elif text == "-" and adjacent(i, ">"):
            return None
        elif token.kind == "punctuation" and text in _BINARY_OPERATORS:
            operand = True
        else:
            return None
        i += 1
    return reads if not operand and not frames else None


def _parse_type(tokens: list[SQLToken], at: int, depth: int = 0) -> int:
    """The index after the type that starts at ``at``, or -1.

    A bare name, with arguments in parentheses that are types, numbers (``-``
    allowed), strings, ``'name' = number`` (Enum) or an element name, bare or
    quoted, and its type (``Tuple(a UInt64)``, ``Tuple(`a-b` UInt64)``).
    Types nested deeper than ``_TYPE_DEPTH`` are not parsed.
    """
    count = len(tokens)
    if depth > _TYPE_DEPTH or at >= count or tokens[at].kind != "identifier":
        return -1
    if at + 1 >= count or tokens[at + 1].text != "(":
        return at + 1
    j = at + 2
    while True:
        token = tokens[j] if j < count else None
        if token is not None and token.kind == "number":
            j += 1
        elif (
            token is not None
            and token.text == "-"
            and j + 1 < count
            and tokens[j + 1].kind == "number"
        ):
            j += 2
        elif token is not None and token.kind == "string":
            j += 1
            if j < count and tokens[j].text == "=":
                j += 1
                if j < count and tokens[j].text == "-":
                    j += 1
                if j >= count or tokens[j].kind != "number":
                    return -1
                j += 1
        elif (
            token is not None
            and token.kind == "quoted_identifier"
            and j + 1 < count
            and tokens[j + 1].kind == "identifier"
        ):
            j = _parse_type(tokens, j + 1, depth + 1)
            if j == -1:
                return -1
        else:
            j = _parse_type(tokens, j, depth + 1)
            if j == -1:
                return -1
            if j < count and tokens[j].kind == "identifier":
                j = _parse_type(tokens, j, depth + 1)
            if j == -1:
                return -1
        if j < count and tokens[j].text == ")":
            return j + 1
        if j >= count or tokens[j].text != ",":
            return -1
        j += 1


def _cycle_releases(
    key: str,
    reads: dict[str, set[str]],
    old_reads: dict[str, set[str]],
    added: set[str],
) -> list[str]:
    """Columns whose MODIFY must run before the MODIFY that sets ``key``'s expression (#769).

    ClickHouse rejects an expression that closes a cycle. The new expression
    closes one through column P when it reads a column that leads to P, and
    P's old expression reads a column that leads back to ``key``, which P's
    new expression no longer reads. "Leads to" follows reads that both the
    old and the new expression of their column have, so the path exists in
    every intermediate state and only P's MODIFY breaks it. On the way to P
    it also follows the reads of ``added`` columns: the MODIFY runs after the
    ADD of every added column its expression reads through them. Every such
    P is read by the new expression through the new schema, so these edges
    can't form a cycle unless the new schema has one.
    """

    def reachable(start: str, through_added: bool) -> set[str]:
        seen = {start}
        pending = [start]
        while pending:
            column = pending.pop()
            follow = through_added and column in added
            for read in reads.get(column, ()):
                if (follow or read in old_reads.get(column, ())) and read not in seen:
                    seen.add(read)
                    pending.append(read)
        return seen

    released: dict[str, None] = {}
    for read in reads.get(key, ()):
        for column in reachable(read, through_added=True):
            if column == key:
                continue
            for dropped in old_reads.get(column, ()):
                if dropped not in reads.get(column, ()) and key in reachable(
                    dropped, through_added=False
                ):
                    released[column] = None
    return list(released)


def _column_key(database: str, table: str, column: str) -> str:
    return f"table:{database}.{table}:column:{column}"


def _dotted_names(sql: str, columns: set[str]) -> list[str]:
    """The column names that ``sql`` reads, from runs of bare or quoted names joined by dots.

    A run is ``n.x`` with bare or quoted parts and any comments around the dot. Like
    ClickHouse, a run reads its longest leading part that is a column: ``n.x``
    reads the column ``n.x`` when there is one, and otherwise ``n`` (a subcolumn
    of ``n``). A run whose leading parts are no column is read without them, so
    ``t.col`` and ``db.t.col`` read ``col`` (#748). A tuple element by position
    ends the run: ``t.1.a`` reads ``t``. A run followed by ``(`` is a function
    call, not a column, and a run that starts on a name ``_not_column_names``
    skips reads nothing, so ``a -> a.x`` reads no ``a.x`` (#768).
    """
    return _names_read([token for token in tokenize_sql(sql) if not is_trivia(token)], columns)


def _names_read(tokens: list[SQLToken], columns: set[str]) -> list[str]:
    """``_dotted_names`` over the ``tokens`` of an expression, without trivia."""
    skipped = _not_column_names(tokens)
    found: list[str] = []
    i = 0
    while i < len(tokens):
        first = i
        run: list[str] = []
        # A tuple element by position (``t.1``) and the parts after it are one path
        # into the run before it, so ``t.1.a.b`` reads only ``t``.
        element = False
        name = identifier_name(tokens[i])
        while name is not None:
            if not element:
                run.append(name)
            i += 1
            if i >= len(tokens) or tokens[i].text != ".":
                break
            following = tokens[i + 1] if i + 1 < len(tokens) else None
            if following is not None and following.kind == "number":
                element = True
            if following is None:
                name = None
            elif following.kind == "number":
                name = following.text
            else:
                name = identifier_name(following)
            if name is not None:
                i += 1
        if not run:
            i += 1
        if (i < len(tokens) and tokens[i].text == "(") or first in skipped:
            continue
        for start in range(len(run)):
            match = _longest_column_prefix(run[start:], columns)
            if match is not None:
                found.append(match)
                break
    return found


def _longest_column_prefix(parts: list[str], columns: set[str]) -> str | None:
    for end in range(len(parts), 0, -1):
        name = ".".join(parts[:end])
        if name in columns:
            return name
    return None


def _column_default_reads(definitions: Sequence[SchemaDefinition]) -> dict[str, set[str]]:
    """Column operation key to the keys of the same table's columns its default expression names.

    A name followed by ``(`` is a function call, not a column, and neither are
    the names ``_not_column_names`` finds.
    """
    graph: dict[str, set[str]] = {}
    for definition in definitions:
        if not isinstance(definition, TableDefinition):
            continue
        prefix = f"table:{definition.database}.{definition.name}:column:"
        names = {column.name for column in definition.columns}
        for column in definition.columns:
            if column.default is None:
                continue
            parsed = parse_column_default(column.default)
            if parsed.kind != "expression":
                continue
            read: set[str] = set()
            for name in _dotted_names(parsed.sql, names):
                if name != column.name:
                    read.add(prefix + name)
            graph[prefix + column.name] = read
    return graph


def _plain_facts(
    definitions: Sequence[SchemaDefinition], tables: dict[str, None]
) -> tuple[dict[str, dict[str, set[str]]], set[str]]:
    """For the ``tables``: ``_table_id`` to ``_column_id`` to the ``_column_id`` values it reads.

    The reads are ``_plain_reads``; the second value is the tables with an
    expression that is not plain. Only the ``tables`` are tokenized, and no
    tokens are kept.
    """
    plain: dict[str, dict[str, set[str]]] = {}
    uncertain: set[str] = set()
    for definition in definitions:
        if not isinstance(definition, TableDefinition):
            continue
        table = _table_id(definition.database, definition.name)
        if table not in tables:
            continue
        table_plain = plain.setdefault(table, {})
        names = {column.name for column in definition.columns}
        for column in definition.columns:
            if column.default is None:
                continue
            parsed = parse_column_default(column.default)
            if parsed.kind != "expression":
                continue
            certain = _plain_reads(
                [token for token in tokenize_sql(parsed.sql) if not is_trivia(token)], names
            )
            if certain is None:
                uncertain.add(table)
                continue
            table_plain[f"{table}\x00{column.name}"] = {
                f"{table}\x00{name}" for name in certain if name != column.name
            }
    return plain, uncertain


def _table_ttl_reads(definitions: Sequence[SchemaDefinition]) -> dict[str, set[str]]:
    """Table TTL operation key to the keys of the table's columns the TTL names.

    The TTL is read with the same rules as a column's default expression
    (``_dotted_names``).
    """
    graph: dict[str, set[str]] = {}
    for definition in definitions:
        if not isinstance(definition, TableDefinition) or definition.ttl is None:
            continue
        names = {column.name for column in definition.columns}
        graph[f"table:{definition.database}.{definition.name}:ttl"] = {
            _column_key(definition.database, definition.name, name)
            for name in _dotted_names(definition.ttl, names)
        }
    return graph


def _not_column_names(tokens: list[SQLToken]) -> set[int]:
    """Indices of the ``tokens`` (trivia removed) that name no column (#768).

    A lambda parameter (``x -> x``, ``(x, y) -> x + y``) where its lambda
    declares and uses it, with the ``.name`` parts after a use (``a -> a.x``),
    and the type of ``CAST(x AS T)`` and ``x::T``, with its arguments
    (``Array(Tuple(a UInt64))``). A lambda body runs to the first ``,`` or
    unmatched closing bracket at its own depth, so a name after the lambda
    still reads a column.
    """
    skipped: set[int] = set()
    count = len(tokens)

    def text_at(i: int) -> str | None:
        return tokens[i].text if 0 <= i < count else None

    def is_pair(i: int, first: str, second: str) -> bool:
        return (
            text_at(i) == first
            and text_at(i + 1) == second
            and tokens[i].end == tokens[i + 1].start
        )

    def is_name(i: int) -> bool:
        return 0 <= i < count and identifier_name(tokens[i]) is not None

    for i, token in enumerate(tokens):
        if is_pair(i, "-", ">"):
            params = _lambda_parameters(tokens, i)
            if params is None:
                continue
            names, start = params
            skipped.update(range(start, i))
            end = _group_end(tokens, i + 2)
            j = i + 2
            while j < end:
                name = identifier_name(tokens[j])
                if name is not None and name in names and text_at(j - 1) != ".":
                    skipped.add(j)
                    while text_at(j + 1) == "." and is_name(j + 2):
                        j += 2
                        skipped.add(j)
                j += 1
        elif is_pair(i, ":", ":"):
            if not is_name(i + 2):
                continue
            stop = _closing_paren(tokens, i + 3) + 1 if text_at(i + 3) == "(" else i + 3
            skipped.update(range(i + 2, stop))
        elif token.kind == "identifier" and token.text.lower() == "cast" and text_at(i + 1) == "(":
            close = _closing_paren(tokens, i + 1)
            depth = 0
            for j in range(i + 2, close):
                inner = tokens[j]
                if inner.text in ("(", "[", "{"):
                    depth += 1
                elif inner.text in (")", "]", "}"):
                    depth -= 1
                elif depth == 0 and inner.kind == "identifier" and inner.text.lower() == "as":
                    skipped.update(range(j, close))
                    break
    return skipped


def _lambda_parameters(tokens: list[SQLToken], arrow: int) -> tuple[set[str], int] | None:
    """The parameters of the lambda whose ``->`` starts at ``arrow``.

    The name before it, or the names of a ``(a, b)`` list before it, with the
    index of the first token that declares them. Any other shape declares
    nothing.
    """
    if arrow < 1:
        return None
    before = tokens[arrow - 1]
    single = identifier_name(before)
    if single is not None:
        return {single}, arrow - 1
    if before.text != ")":
        return None
    names: set[str] = set()
    j = arrow - 2
    while j >= 0:
        name = identifier_name(tokens[j])
        if name is None:
            return None
        names.add(name)
        separator = tokens[j - 1].text if j >= 1 else None
        if separator == "(":
            return names, j - 1
        if separator != ",":
            return None
        j -= 2
    return None


def _group_end(tokens: list[SQLToken], start: int) -> int:
    """Index of the first ``,`` or unmatched closing bracket at ``start``'s depth, or the end."""
    depth = 0
    for j in range(start, len(tokens)):
        text = tokens[j].text
        if text in ("(", "[", "{"):
            depth += 1
        elif text in (")", "]", "}"):
            if depth == 0:
                return j
            depth -= 1
        elif text == "," and depth == 0:
            return j
    return len(tokens)


def _closing_paren(tokens: list[SQLToken], open_: int) -> int:
    """Index of the ``)`` that closes the ``(`` at ``open_``, or the end."""
    depth = 0
    for j in range(open_, len(tokens)):
        text = tokens[j].text
        if text == "(":
            depth += 1
        elif text == ")":
            depth -= 1
            if depth == 0:
                return j
    return len(tokens)


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
    shape["lifetime"] = _dictionary_lifetime_fingerprint(definition.lifetime)
    shape.pop("comment", None)
    if omit_source:
        shape.pop("source", None)
    return shape


_LIFETIME_RANGE_RE = re.compile(
    js_regex(r"^MIN\s+(\S+)\s+MAX\s+(\S+)$|^MAX\s+(\S+)\s+MIN\s+(\S+)$"), re.IGNORECASE
)


def _dictionary_lifetime_fingerprint(lifetime: str) -> str:
    """The stored form of a ``LIFETIME`` (TS ``dictionaryLifetimeFingerprint``).

    ClickHouse stores ``LIFETIME(300)`` as ``LIFETIME(MIN 0 MAX 300)`` and
    ``LIFETIME(MAX 300 MIN 10)`` as ``LIFETIME(MIN 10 MAX 300)``, so a
    dictionary pulled back compares by that stored form.
    """
    trimmed = js_trim(lifetime)
    if re.fullmatch(r"\d+", trimmed, re.ASCII):
        return f"MIN 0 MAX {trimmed}"
    match = _LIFETIME_RANGE_RE.match(trimmed)
    if match is None:
        return trimmed
    if match.group(1) is not None:
        return f"MIN {match.group(1)} MAX {match.group(2)}"
    return f"MIN {match.group(4)} MAX {match.group(3)}"


def _diff_dictionary(
    old: DictionaryDefinition, new: DictionaryDefinition
) -> list[MigrationOperation]:
    omit_source = _dictionary_source_is_hidden(new.source)
    if _dictionary_comparison_shape(old, omit_source) == _dictionary_comparison_shape(
        new, omit_source
    ):
        return _diff_comment(old, new)

    return [
        MigrationOperation(
            type="create_dictionary",
            key=definition_key(new),
            risk="caution",
            sql=render_dictionary_sql(new, replace=True),
        )
    ]


def plan_diff(
    old_definitions: Sequence[SchemaDefinition],
    new_definitions: Sequence[SchemaDefinition],
    *,
    index_granularity: int | None = None,
) -> MigrationPlan:
    old_canonical = canonicalize_definitions(old_definitions, index_granularity=index_granularity)
    new_canonical = canonicalize_definitions(new_definitions, index_granularity=index_granularity)
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
            if new_def.as_ != matched.as_:
                _push_drop(operations, matched, "caution")
                _push_create(operations, new_def, "caution")
            else:
                operations.extend(_diff_comment(matched, new_def))
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

    # The sort is stable, so operations that share a key keep the order
    # _diff_tables pushed them in: a column's REMOVE DEFAULT before its MODIFY COLUMN.
    operations.sort(key=lambda op: (_rank(op), _alter_rank(op), op.key))
    operations = _order_operations(
        operations,
        drop=invert_dependency_graph(build_dependency_graph(old_canonical)),
        create=build_dependency_graph(new_canonical),
        previous=old_canonical,
        next_=new_canonical,
    )

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
