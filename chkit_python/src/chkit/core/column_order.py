"""Order the column statements of a plan by the columns their expressions read."""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence

from chkit.core.column_cycle_repair import _cycle_releases, _repaired_order
from chkit.core.column_reads import (
    _column_default_reads,
    _column_key,
    _column_object_id,
    _rename_object_id,
    _table_ttl_reads,
    _ttl_object_id,
    column_rename_key,
)
from chkit.core.identifier import quote_identifier, render_qualified_name
from chkit.core.model import (
    ColumnRenameSuggestion,
    MigrationOperation,
    SchemaDefinition,
    TableDefinition,
)

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
    reads = _column_default_reads(next_, column_key_of=_column_object_id)
    old_reads = _column_default_reads(previous, column_key_of=_column_object_id)
    # ALTER's check for cyclic defaults also reads lambda parameters (#799).
    cycle_reads = _column_default_reads(next_, lambdas=True, column_key_of=_column_object_id)
    old_cycle_reads = _column_default_reads(previous, lambdas=True, column_key_of=_column_object_id)
    ttl_reads = _table_ttl_reads(next_)
    old_ttl_reads = _table_ttl_reads(previous)
    renamed_to = {
        _rename_object_id(rename): _column_object_id(rename.database, rename.table, rename.to)
        for rename in renames
    }
    statements = sorted((op for op in operations if is_column_statement(op)), key=lambda op: op.key)
    ids = _statement_object_ids(statements, previous, next_, renames)
    # The statements of one object (``ids``) are next to each other in key order.
    last_of: dict[str, int] = {}
    previous_of: list[int | None] = []
    for index, id_ in enumerate(ids):
        previous_of.append(last_of.get(id_))
        last_of[id_] = index

    providers: dict[str, list[int]] = {}
    releasers: dict[str, list[int]] = {}
    modifies: dict[str, list[int]] = {}
    for index, op in enumerate(statements):
        id_ = ids[index]
        if op.type == "alter_table_add_column":
            providers.setdefault(id_, []).append(index)
        renamed = renamed_to.get(id_)
        if op.type == "alter_table_rename_column" and renamed is not None:
            providers.setdefault(renamed, []).append(index)
        if op.type == "alter_table_modify_column":
            modifies.setdefault(id_, []).append(index)
        if op.type in ("alter_table_modify_column", "alter_table_drop_column"):
            for read in old_reads.get(id_, ()):
                releasers.setdefault(read, []).append(index)
        if op.type == "alter_table_modify_ttl":
            for read in old_ttl_reads.get(id_, ()):
                releasers.setdefault(read, []).append(index)

    added = {
        id_ for id_, op in zip(ids, statements, strict=True) if op.type == "alter_table_add_column"
    }
    releases = _cycle_releases(cycle_reads, old_cycle_reads, added, set(modifies))
    prerequisites: list[list[int]] = []
    for index, op in enumerate(statements):
        id_ = ids[index]
        found: dict[int, None] = {}
        if op.type in ("alter_table_add_column", "alter_table_modify_column"):
            for read in reads.get(id_, ()):
                for other in providers.get(read, []):
                    found[other] = None
        if op.type == "alter_table_modify_ttl":
            for read in ttl_reads.get(id_, ()):
                for other in providers.get(read, []):
                    found[other] = None
        if op.type == "alter_table_drop_column":
            for other in releasers.get(id_, []):
                found[other] = None
        # A column's last statement is the MODIFY COLUMN that sets its new expression.
        if op.type == "alter_table_modify_column" and last_of[id_] == index:
            for column in releases.get(id_, []):
                for other in modifies.get(column, []):
                    found[other] = None
        before = previous_of[index]
        if before is not None:
            found[before] = None
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


def _statement_object_ids(
    statements: Sequence[MigrationOperation],
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
    renames: Sequence[ColumnRenameSuggestion],
) -> list[str]:
    """The id of the object each column statement changes (#801).

    A key that names one object of the definitions or ``renames`` is that
    object's. A key that names several (keys of two tables can be the same)
    is the one whose table the statement's SQL alters, and for a RENAME
    COLUMN whose SQL it is. A statement that is still not one object's keeps
    its key as its id, so it reads and provides nothing.
    """
    candidates: dict[str, dict[str, Callable[[str], bool]]] = {}

    def add(kind: str, key: str, id_: str, matches: Callable[[str], bool]) -> None:
        candidates.setdefault(json.dumps([kind, key]), {}).setdefault(id_, matches)

    for definition in [*previous, *next_]:
        if not isinstance(definition, TableDefinition):
            continue
        prefix = f"ALTER TABLE {render_qualified_name(definition.database, definition.name)} "

        def starts(sql: str, prefix: str = prefix) -> bool:
            return sql.startswith(prefix)

        for column in definition.columns:
            add(
                "column",
                _column_key(definition.database, definition.name, column.name),
                _column_object_id(definition.database, definition.name, column.name),
                starts,
            )
        add(
            "ttl",
            f"table:{definition.database}.{definition.name}:ttl",
            _ttl_object_id(definition.database, definition.name),
            starts,
        )
    for rename in renames:
        sql = (
            f"ALTER TABLE {render_qualified_name(rename.database, rename.table)} "
            f"RENAME COLUMN IF EXISTS {quote_identifier(rename.from_)} "
            f"TO {quote_identifier(rename.to)};"
        )

        def equals(other: str, sql: str = sql) -> bool:
            return other == sql

        add("rename", column_rename_key(rename), _rename_object_id(rename), equals)

    def kind_of(op: MigrationOperation) -> str:
        if op.type == "alter_table_modify_ttl":
            return "ttl"
        return "rename" if op.type == "alter_table_rename_column" else "column"

    ids: list[str] = []
    for op in statements:
        slot = json.dumps([kind_of(op), op.key])
        found = candidates.get(slot, {})
        matching = list(found)
        if len(matching) > 1:
            matching = [id_ for id_, matches in found.items() if matches(op.sql)]
        ids.append(matching[0] if len(matching) == 1 else slot)
    return ids
