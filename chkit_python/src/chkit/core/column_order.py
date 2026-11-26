"""Order the column statements of a plan by the columns their expressions read."""

from __future__ import annotations

from collections.abc import Sequence

from chkit.core.column_cycle_repair import _cycle_releases, _repaired_order
from chkit.core.column_reads import (
    _column_default_reads,
    _column_key,
    _table_ttl_reads,
    column_rename_key,
)
from chkit.core.model import ColumnRenameSuggestion, MigrationOperation, SchemaDefinition

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
    reads = _column_default_reads(next_)
    old_reads = _column_default_reads(previous)
    # ALTER's check for cyclic defaults also reads lambda parameters (#799).
    cycle_reads = _column_default_reads(next_, lambdas=True)
    old_cycle_reads = _column_default_reads(previous, lambdas=True)
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
    releases = _cycle_releases(cycle_reads, old_cycle_reads, added, set(modifies))
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
            for column in releases.get(op.key, []):
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
