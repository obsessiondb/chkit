"""Order the column statements of a plan by the columns their expressions read."""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence

from chkit.core.canonical import definition_key
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
    MaterializedViewDefinition,
    MigrationOperation,
    SchemaDefinition,
    TableDefinition,
)
from chkit.core.object_dependencies import (
    build_dependency_graph,
    order_by_dependencies,
    query_column_mentions,
)
from chkit.core.sql import column_type_fingerprint

# The table TTL statement (MODIFY or REMOVE TTL) sorts with the column
# statements: it reads columns that are added and dropped (#769).
_COLUMN_STATEMENTS = frozenset(
    {
        "alter_table_add_column",
        "alter_table_modify_column",
        "alter_table_drop_column",
        "alter_table_rename_column",
        "alter_table_modify_ttl",
        "alter_materialized_view_modify_query",
    }
)


def is_column_statement(op: MigrationOperation) -> bool:
    return op.type in _COLUMN_STATEMENTS


def order_column_statements(  # noqa: PLR0915
    operations: Sequence[MigrationOperation],
    *,
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
    renames: Sequence[ColumnRenameSuggestion],
) -> list[MigrationOperation]:
    """Order the column, TTL and view query statements in one sort (TS orderColumnStatements).

    The statements are ADD, MODIFY, DROP and RENAME COLUMN and the table TTL
    statement of every table, and the MODIFY QUERY of every materialized view,
    from their key order (#681, #745, #746, #758, #760, #769, #775):

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
    - a MODIFY that changes the type of X runs after the statements that stop
      reading X, and before those that start reading it (``_add_type_change_order``, #814);
    - when the order still closes a cycle in a table whose reads are certain
      (``_repaired_order``), the first breaker in key order runs before the
      MODIFY that closes it (``_break_closed_cycles``, #775);
    - a MODIFY QUERY runs after an ADD or MODIFY of X or a RENAME to X if
      its new query mentions X, and before a DROP of X if its old query
      mentions X, on tables that the respective query reads or writes. A
      star mentions every column;
    - statements of the same column keep their order.

    Members of a cycle keep their key order. The statements fill the positions
    the column statements had, so every other operation keeps its place, and
    a table's statements move past another table's only through a MODIFY
    QUERY that reads both (they share no other edge). ``renames`` names the
    columns of each RENAME COLUMN in ``operations``.
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
    queries = [
        index
        for index, op in enumerate(statements)
        if op.type == "alter_materialized_view_modify_query"
    ]
    ids = _statement_object_ids(statements, previous, next_, renames)
    query_reads = _materialized_view_query_reads(next_) if queries else {}
    old_query_reads = _materialized_view_query_reads(previous) if queries else {}
    columns = [_statement_column(renamed_to.get(id_, id_)) for id_ in ids] if queries else []
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
            for query in queries:
                reads_column = old_query_reads.get(statements[query].key)
                if reads_column is not None and reads_column(columns[index]):
                    found[query] = None
        if op.type == "alter_materialized_view_modify_query":
            reads_column = query_reads.get(op.key)
            if reads_column is not None:
                for candidate_index, candidate in enumerate(statements):
                    if candidate.type in (
                        "alter_table_add_column",
                        "alter_table_modify_column",
                        "alter_table_rename_column",
                    ) and reads_column(columns[candidate_index]):
                        found[candidate_index] = None
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
    _add_type_change_order(
        prerequisites,
        statements,
        ids,
        operations,
        modifies,
        previous=previous,
        next_=next_,
        renames=renames,
        graphs=(reads, old_reads, ttl_reads, old_ttl_reads),
        cycle_graphs=(cycle_reads, old_cycle_reads),
    )

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


def _statement_column(id_: str) -> tuple[str, str] | None:
    """The exact table key and column name represented by a resolved statement id."""
    parts: list[str] = json.loads(id_)
    if parts[0] != "column" or len(parts) != 4:  # noqa: PLR2004
        return None
    _, database, table, name = parts
    return f"table:{database}.{table}", name


def dropped_statement_columns(
    operations: Sequence[MigrationOperation], previous: Sequence[SchemaDefinition]
) -> list[tuple[str, str]]:
    drops = [op for op in operations if op.type == "alter_table_drop_column"]
    if not drops:
        return []
    return [
        column
        for id_ in _statement_object_ids(drops, previous, (), ())
        if (column := _statement_column(id_)) is not None
    ]


def _materialized_view_query_reads(
    definitions: Sequence[SchemaDefinition],
) -> dict[str, Callable[[tuple[str, str] | None], bool]]:
    """MODIFY QUERY operation key to whether the query mentions a column it reads or writes."""
    graph = build_dependency_graph(definitions)
    reads: dict[str, Callable[[tuple[str, str] | None], bool]] = {}
    for definition in definitions:
        if not isinstance(definition, MaterializedViewDefinition):
            continue
        key = definition_key(definition)
        tables = graph.get(key, set())
        mentions = query_column_mentions(definition.as_)

        def reads_column(
            column: tuple[str, str] | None,
            tables: set[str] = tables,
            mentions: Callable[[str], bool] = mentions,
        ) -> bool:
            return column is not None and column[0] in tables and mentions(column[1])

        reads[f"{key}:query"] = reads_column
    return reads


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


_Reads = dict[str, set[str]]


def _add_type_change_order(
    prerequisites: list[list[int]],
    statements: Sequence[MigrationOperation],
    ids: Sequence[str],
    operations: Sequence[MigrationOperation],
    modifies: dict[str, list[int]],
    *,
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
    renames: Sequence[ColumnRenameSuggestion],
    graphs: tuple[_Reads, _Reads, _Reads, _Reads],
    cycle_graphs: tuple[_Reads, _Reads],
) -> None:
    """Add the prerequisites that order the MODIFY changing the type of a column X
    against the statements whose expressions read X (#814, TS ``addTypeChangeOrder``).

    ClickHouse checks every expression of the table against the new type, and a
    new expression against the current one (code 43): ``MODIFY COLUMN a UInt64``
    fails while ``b DEFAULT length(a)`` stands, and ``b DEFAULT a + 1`` fails
    while ``a`` is still a String. So the MODIFY of X runs after the ADD, MODIFY
    or DROP of every column, and the TTL change, whose old expression reads X and
    whose new one doesn't, and before every statement whose new expression reads
    X and whose old one doesn't. They can't tell which types an expression
    accepts, so the rest keeps the order of the sort without them (``base``): a
    statement whose old and new expressions both read X keeps its side of the
    MODIFY of X (no order helps when both need their own type of X), and the type
    changes keep their order among themselves (a third expression can read two of
    them). A prerequisite that would close a cycle is left out, and those the base
    order satisfies go in first, so a conflict keeps that order. None are added
    when the base order already satisfies them all, when their order moves a
    statement past an operation of ``operations`` that is not a column statement,
    changes the order of the ADD and DROP COLUMNs among themselves or of the type
    changes, or closes a cycle of column expressions at some statement
    (``_closes_expression_cycle``), when an ADD or MODIFY COLUMN is not one
    column's (``ids``, #801), or when a table has a RENAME COLUMN in
    ``renames``. Statements, reads and type changes are matched by object id,
    so two tables whose operation keys are the same keep their own. The cycle repair
    (``_repaired_order``) runs after this, and its breaker edges come on top of
    these prerequisites, so they hold in its order too. A temporary cycle the
    repair would break also closes in the order with them, in any table, so in
    practice that plan keeps none of them.
    """
    reads, old_reads, ttl_reads, old_ttl_reads = graphs
    changes: dict[str, int] = {}
    # The type changes of each table, in key order.
    tables: list[list[int]] = []
    for columns in _type_changed_columns(previous, next_, renames):
        tables.append([])
        for id_ in columns:
            if modifies.get(id_):
                changes[id_] = modifies[id_][-1]
                tables[-1].append(changes[id_])
    if not changes or _has_unresolved_column_statement(statements, ids, previous, next_):
        return
    # [statement, prerequisite] pairs, and [statement, MODIFY] pairs that read X before and after.
    edges: list[tuple[int, int]] = []
    kept: list[tuple[int, int]] = []
    for index, op in enumerate(statements):
        if op.type == "alter_table_rename_column":
            continue
        ttl = op.type == "alter_table_modify_ttl"
        before = (old_ttl_reads if ttl else old_reads).get(ids[index], set())
        after = (ttl_reads if ttl else reads).get(ids[index], set())
        for read in before | after:
            change = changes.get(read)
            if change is None:
                continue
            if read in before and read in after:
                kept.append((index, change))
            else:
                edges.append((change, index) if read in before else (index, change))

    def sort_all() -> list[int]:
        return order_by_dependencies(
            list(range(len(statements))),
            str,
            lambda key: [str(other) for other in prerequisites[int(key)]],
        )

    base = sort_all()
    position = {index: at for at, index in enumerate(base)}

    def satisfied(edge: tuple[int, int]) -> bool:
        return position[edge[1]] < position[edge[0]]

    if all(satisfied(edge) for edge in edges):
        return
    lengths = [len(before) for before in prerequisites]
    # The base order satisfies these, so they close no cycle. Sorted, like the
    # edges below, so the hash seed doesn't change the prerequisite lists.
    for one, other in sorted(kept):
        first, second = (one, other) if position[one] < position[other] else (other, one)
        if first != second:
            prerequisites[second].append(first)

    _add_acyclic(prerequisites, sorted(edges, key=lambda edge: (not satisfied(edge), edge)), base)
    # Last, each table's type changes keep their base order where the edges allow.
    chains: list[tuple[int, int]] = []
    for table in tables:
        changed = sorted(table, key=lambda index: position[index])
        chains.extend(zip(changed[1:], changed, strict=False))
    _add_acyclic(prerequisites, chains, sort_all())
    order = sort_all()
    # An ADD COLUMN appends the column, a DROP can remove the column an ADD
    # replaces (the last physical one, or ``k.x`` before ``k``), and a third
    # expression can read two changed columns: so the ADDs and DROPs, and the
    # type changes, keep their order.
    types = set(changes.values())
    add_or_drop = ("alter_table_add_column", "alter_table_drop_column")

    def fixed(order: Sequence[int]) -> tuple[list[int], list[int]]:
        adds = [index for index in order if statements[index].type in add_or_drop]
        return adds, [index for index in order if index in types]

    moved = _moves_past_other_operations(order, position, operations) or fixed(order) != fixed(base)
    # ALTER's check for cyclic defaults also reads lambda parameters (#799).
    if moved or _closes_expression_cycle(order, statements, ids, cycle_graphs):
        for index, length in enumerate(lengths):
            del prerequisites[index][length:]


def _add_acyclic(
    prerequisites: list[list[int]], edges: Sequence[tuple[int, int]], order: Sequence[int]
) -> None:
    """Add each ``(statement, prerequisite)`` edge that closes no cycle (TS ``add``).

    An edge whose prerequisite comes first in ``order``, a topological order of
    the prerequisites so far, needs no search and keeps that order valid. A sort
    with a cycle is no such order.
    """
    at = {index: at for at, index in enumerate(order)}
    topological = all(
        at[other] < at[index] for index, before in enumerate(prerequisites) for other in before
    )
    sorted_at: dict[int, int] | None = at if topological else None

    def waits_on(start: int, target: int) -> bool:
        seen = {start}
        pending = [start]
        while pending:
            index = pending.pop()
            if index == target:
                return True
            for other in prerequisites[index]:
                if other not in seen:
                    seen.add(other)
                    pending.append(other)
        return False

    for index, other in edges:
        certain = sorted_at is not None and sorted_at[other] < sorted_at[index]
        if not certain and waits_on(other, index):
            continue
        prerequisites[index].append(other)
        if not certain:
            sorted_at = None


def _moves_past_other_operations(
    order: Sequence[int], position: dict[int, int], operations: Sequence[MigrationOperation]
) -> bool:
    """Whether ``order`` puts a statement in another run of column statement slots of
    ``operations`` than ``position`` does, past an operation that is not one."""
    runs: list[int] = []
    run = 0
    previous_is_column = False
    for op in operations:
        if is_column_statement(op):
            runs.append(run)
        elif previous_is_column:
            run += 1
        previous_is_column = is_column_statement(op)
    return any(runs[slot] != runs[position[index]] for slot, index in enumerate(order))


def _has_unresolved_column_statement(
    statements: Sequence[MigrationOperation],
    ids: Sequence[str],
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
) -> bool:
    """Whether an ADD or MODIFY COLUMN has no column's id (TS ``hasUnresolvedColumnStatement``).

    ``_statement_object_ids`` left its key (#801): its new expression would not be
    replayed in ``_closes_expression_cycle``, which then could see fewer reads than
    ClickHouse.
    """
    columns = {
        _column_object_id(definition.database, definition.name, column.name)
        for definition in [*previous, *next_]
        if isinstance(definition, TableDefinition)
        for column in definition.columns
    }
    return any(
        op.type in ("alter_table_add_column", "alter_table_modify_column") and id_ not in columns
        for op, id_ in zip(statements, ids, strict=True)
    )


def _closes_expression_cycle(
    order: Sequence[int],
    statements: Sequence[MigrationOperation],
    ids: Sequence[str],
    graphs: tuple[dict[str, set[str]], dict[str, set[str]]],
) -> bool:
    """Whether running the column statements in ``order`` gives some column an expression
    that reads itself through the others at that point (TS ``closesExpressionCycle``).

    ClickHouse rejects that (``Cyclic alias detected``). The replay starts from the
    old expressions, takes a column's new expression at its last statement and
    drops a column at its DROP. A REMOVE before the last statement is not
    replayed, so this sees more reads than ClickHouse, never fewer.
    """
    reads, old_reads = graphs
    current: dict[str, set[str]] = dict(old_reads)
    last = {id_: index for index, id_ in enumerate(ids)}
    for index in order:
        op = statements[index]
        id_ = ids[index]
        if op.type == "alter_table_drop_column":
            current.pop(id_, None)
        if op.type not in ("alter_table_add_column", "alter_table_modify_column"):
            continue
        # An object's new expression is set at its last statement.
        if last[id_] != index:
            continue
        current[id_] = reads.get(id_, set())
        seen: set[str] = set()
        pending = list(current[id_])
        while pending:
            column = pending.pop()
            if column == id_:
                return True
            if column in seen:
                continue
            seen.add(column)
            pending.extend(current.get(column, ()))
    return False


def _type_changed_columns(
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
    renames: Sequence[ColumnRenameSuggestion],
) -> list[list[str]]:
    """Ids of the columns whose type changes, per table with no rename in ``renames``."""
    renamed = {(rename.database, rename.table) for rename in renames}
    old_tables = {(d.database, d.name): d for d in previous if isinstance(d, TableDefinition)}
    changed: list[list[str]] = []
    for definition in next_:
        table_id = (definition.database, definition.name)
        if not isinstance(definition, TableDefinition) or table_id in renamed:
            continue
        keys: list[str] = []
        changed.append(keys)
        old_table = old_tables.get((definition.database, definition.name))
        old_columns = {column.name: column for column in (old_table.columns if old_table else [])}
        for column in definition.columns:
            old_column = old_columns.get(column.name)
            old_type = column_type_fingerprint(old_column) if old_column is not None else None
            if old_type is not None and old_type != column_type_fingerprint(column):
                keys.append(_column_object_id(definition.database, definition.name, column.name))
    return changed
