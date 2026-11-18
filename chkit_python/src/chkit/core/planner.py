"""Migration planner: produce a ``MigrationPlan`` from old vs new definitions."""

from __future__ import annotations

import heapq
import json
import re
from collections.abc import Callable, Iterable, Sequence
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
    - when the order still closes a cycle, the first breaker in key order runs
      before the MODIFY that closes it (``_break_closed_cycles``, #775);
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

    changes = _default_changes(statements, reads, previous, next_)
    renamed_tables = [_column_key(rename.database, rename.table, "") for rename in renames]

    # A table with a RENAME COLUMN is not checked: the replay does not rename.
    def checked(index: int) -> bool:
        key = statements[index].key
        return index in changes and not any(key.startswith(prefix) for prefix in renamed_tables)

    sorted_order = order_by_dependencies(
        list(range(len(statements))),
        str,
        lambda key: [str(other) for other in prerequisites[int(key)]],
    )
    ordered_indices = sorted_order
    if _closes_cycle(sorted_order, statements, changes, old_reads, checked):
        repaired = _break_closed_cycles(prerequisites, statements, changes, old_reads, checked)
        if repaired is not None:
            ordered_indices = repaired
    ordered = iter(ordered_indices)
    return [statements[next(ordered)] if is_column_statement(op) else op for op in operations]


def _closes_cycle(
    order: list[int],
    statements: Sequence[MigrationOperation],
    changes: dict[int, set[str]],
    old_reads: dict[str, set[str]],
    checked: Callable[[int], bool],
) -> bool:
    """Whether replaying ``order`` reaches a ``checked`` ADD or MODIFY that closes a cycle (#775).

    ClickHouse rejects such an expression (``Cyclic alias detected``). When
    the replay reaches none, the sorted order stays.
    """
    replay = _DefaultReplay(old_reads)
    for index in order:
        op = statements[index]
        replay.apply(op, changes.get(index))
        if checked(index) and replay.cycle_through(op.key):
            return True
    return False


def _break_closed_cycles(
    prerequisites: list[list[int]],
    statements: Sequence[MigrationOperation],
    changes: dict[int, set[str]],
    old_reads: dict[str, set[str]],
    checked: Callable[[int], bool],
) -> list[int] | None:
    """The order with a cycle's breakers moved before the MODIFY closing it, or none (#775).

    ``_cycle_releases`` adds an edge only when one MODIFY must break the
    cycle in every order. When several could, or the cycle closes through two
    new expressions, this sorts like ``order_by_dependencies`` (the ready
    statement with the lowest key order runs next) while replaying each
    statement. A statement that would close a cycle waits for the breaker
    with the lowest key order: a later statement of a column on the cycle
    whose change removes a read on it. A breaker that already waits for the
    statement is skipped, so the edges never form a cycle. The statements
    before it keep their places, so this is the order that adding the edge and
    sorting again would give. With no breaker, or with a cycle among the
    prerequisites, it returns none.
    """
    replay = _DefaultReplay(old_reads)
    remaining = [len(before) for before in prerequisites]
    dependents: list[list[int]] = [[] for _ in prerequisites]
    for index, before in enumerate(prerequisites):
        for other in before:
            dependents[other].append(index)
    placed = [False] * len(prerequisites)
    ready = [index for index, count in enumerate(remaining) if count == 0]
    order: list[int] = []
    while ready:
        target = heapq.heappop(ready)
        op = statements[target]
        change = changes.get(target)
        previous = replay.reads(op.key)
        replay.apply(op, change)
        cycle = replay.cycle_through(op.key) if checked(target) else set()
        if cycle:
            breaker = next(
                (
                    j
                    for j, other in enumerate(statements)
                    if not placed[j]
                    and other.key != op.key
                    and other.key in cycle
                    and j in changes
                    and any(
                        read in cycle and read not in changes[j]
                        for read in replay.reads(other.key) or ()
                    )
                    and not _waits_for(prerequisites, j, target)
                ),
                None,
            )
            if breaker is None:
                return None
            replay.assign(op.key, previous)
            prerequisites[target].append(breaker)
            dependents[breaker].append(target)
            remaining[target] += 1
            continue
        placed[target] = True
        order.append(target)
        for other in dependents[target]:
            remaining[other] -= 1
            if remaining[other] == 0:
                heapq.heappush(ready, other)
    return order if len(order) == len(statements) else None


def _waits_for(prerequisites: list[list[int]], start: int, target: int) -> bool:
    """Whether statement ``start`` runs after statement ``target`` through ``prerequisites``."""
    seen = {start}
    pending = [start]
    while pending:
        for other in prerequisites[pending.pop()]:
            if other == target:
                return True
            if other not in seen:
                seen.add(other)
                pending.append(other)
    return False


def _default_changes(
    statements: Sequence[MigrationOperation],
    reads: dict[str, set[str]],
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
) -> dict[int, set[str]]:
    """Statement index to the reads its column's expression has after it runs.

    Only for the statements that set an expression: an ADD, a column's last
    MODIFY (which sets the new expression or keeps none), and the REMOVE
    DEFAULT, MATERIALIZED or ALIAS that runs first when the new column has no
    expression. The other statements (REMOVE COMMENT, REMOVE CODEC) keep it.
    """
    removed = _expression_removals(previous, next_)
    changes: dict[int, set[str]] = {}
    for index, op in enumerate(statements):
        first = index == 0 or statements[index - 1].key != op.key
        last = index + 1 == len(statements) or statements[index + 1].key != op.key
        is_modify = op.type == "alter_table_modify_column"
        if op.type == "alter_table_add_column" or (is_modify and last):
            changes[index] = reads.get(op.key, set())
        elif is_modify and first and op.key in removed:
            changes[index] = set()
    return changes


def _expression_removals(
    previous: Sequence[SchemaDefinition], next_: Sequence[SchemaDefinition]
) -> set[str]:
    """Keys of the changed columns whose MODIFY starts with REMOVE DEFAULT.

    The condition is ``render_alter_remove_column_expression``'s.
    """
    old_columns: dict[str, ColumnDefinition] = {}
    for definition in previous:
        if isinstance(definition, TableDefinition):
            for column in definition.columns:
                old_columns[_column_key(definition.database, definition.name, column.name)] = column
    removed: set[str] = set()
    for definition in next_:
        if not isinstance(definition, TableDefinition):
            continue
        for column in definition.columns:
            key = _column_key(definition.database, definition.name, column.name)
            old = old_columns.get(key)
            if (
                old is not None
                and old.default is not None
                and column.default is None
                and column.default_kind != "EPHEMERAL"
            ):
                removed.add(key)
    return removed


class _DefaultReplay:
    """The reads of every column's expression while a plan runs, from the old expressions.

    It keeps each column's readers too, so the search back to a column
    follows edges instead of scanning every column.
    """

    def __init__(self, old_reads: dict[str, set[str]]) -> None:
        self._state: dict[str, set[str]] = {}
        self._readers: dict[str, set[str]] = {}
        for column, reads in old_reads.items():
            self.assign(column, reads)

    def reads(self, column: str) -> set[str] | None:
        return self._state.get(column)

    def assign(self, column: str, reads: set[str] | None) -> None:
        for read in self._state.get(column, ()):
            self._readers[read].discard(column)
        if reads is None:
            self._state.pop(column, None)
            return
        self._state[column] = reads
        for read in reads:
            self._readers.setdefault(read, set()).add(column)

    def apply(self, op: MigrationOperation, change: set[str] | None) -> None:
        """A DROP removes its column; ``change`` sets the column's reads."""
        if op.type == "alter_table_drop_column":
            self.assign(op.key, None)
        if change is not None:
            self.assign(op.key, change)

    def cycle_through(self, column: str) -> set[str]:
        """The columns on a cycle of reads through ``column``, or none."""
        reads_from = _reached(column, lambda other: self._state.get(other, ()))
        if column not in reads_from:
            return set()
        return reads_from & _reached(column, lambda other: self._readers.get(other, ()))


def _reached(start: str, following: Callable[[str], Iterable[str]]) -> set[str]:
    seen: set[str] = set()
    pending = [start]
    while pending:
        for other in following(pending.pop()):
            if other not in seen:
                seen.add(other)
                pending.append(other)
    return seen


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
    tokens = [token for token in tokenize_sql(sql) if not is_trivia(token)]
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
    still reads a column. Also the unit of ``INTERVAL 1 day`` and of
    ``EXTRACT(day FROM ts)``, with the INTERVAL keyword (#775, ``_interval_unit``).
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
        word = token.text.lower() if token.kind == "identifier" else None
        if word == "interval":
            unit = _interval_unit(tokens, i)
            if unit is not None:
                skipped.add(i)
                skipped.add(unit)
        elif (
            word == "extract"
            and text_at(i + 1) == "("
            and _is_unit(tokens, i + 2)
            and _is_word(tokens, i + 3, "from")
        ):
            skipped.add(i + 2)
        elif is_pair(i, "-", ">"):
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


# The units ClickHouse 26.3 accepts in ``INTERVAL n <unit>`` (any case).
_INTERVAL_UNITS = frozenset(
    [
        form
        for unit in (
            "nanosecond", "microsecond", "millisecond", "second", "minute", "hour",
            "day", "week", "month", "quarter", "year",
        )
        for form in (unit, f"{unit}s", f"sql_tsi_{unit}")
    ]
    + ["ns", "ms", "s", "m", "h", "d", "mm", "q", "yy", "yyyy", "qq"]
    + ["wk", "ww", "dd", "hh", "mi", "n", "ss"]
)


def _is_word(tokens: list[SQLToken], i: int, word: str) -> bool:
    return (
        0 <= i < len(tokens) and tokens[i].kind == "identifier" and tokens[i].text.lower() == word
    )


def _is_unit(tokens: list[SQLToken], i: int) -> bool:
    return (
        0 <= i < len(tokens)
        and tokens[i].kind == "identifier"
        and tokens[i].text.lower() in _INTERVAL_UNITS
    )


def _interval_unit(tokens: list[SQLToken], keyword: int) -> int | None:
    """Index of the unit of the ``INTERVAL`` at ``keyword``, or none.

    Its operand is an expression (``INTERVAL x + 1 day``), so the unit is the
    first bare unit word at the operand's depth that follows a value (a name,
    number, string or closing bracket); a unit word that starts an operand is
    a column (``INTERVAL d d`` reads ``d``). The search ends at a ``,``, an
    unmatched closing bracket or the next INTERVAL, so ``INTERVAL '1 day'``
    has no unit.
    """
    depth = 0
    after_value = False
    for j in range(keyword + 1, len(tokens)):
        token = tokens[j]
        if depth == 0 and after_value and _is_unit(tokens, j):
            return j
        if token.text in ("(", "[", "{"):
            depth += 1
        elif token.text in (")", "]", "}"):
            depth -= 1
            if depth < 0:
                return None
        elif depth == 0 and (token.text == "," or _is_word(tokens, j, "interval")):
            return None
        after_value = depth == 0 and (token.kind != "punctuation" or token.text in (")", "]", "}"))
    return None


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
