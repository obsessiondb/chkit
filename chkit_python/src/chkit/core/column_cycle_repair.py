"""Order the column statements that would close a default cycle (#769, #775)."""

from __future__ import annotations

import heapq
from collections.abc import Callable, Iterable, Sequence

from chkit.core.column_reads import (
    _EXPRESSION_KEYWORDS,
    _LITERAL_WORDS,
    _column_key,
    _plain_facts,
    _table_id,
    column_rename_key,
)
from chkit.core.column_shape import _columns_equal
from chkit.core.model import (
    ColumnDefinition,
    ColumnRenameSuggestion,
    MigrationOperation,
    SchemaDefinition,
    TableDefinition,
)
from chkit.core.object_dependencies import order_by_dependencies, strongly_connected_components


def _cycle_releases(
    reads: dict[str, set[str]],
    old_reads: dict[str, set[str]],
    added: set[str],
    modified: set[str],
) -> dict[str, list[str]]:
    """For each ``modified`` column K, the ``modified`` columns whose MODIFY must run first (#769).

    These MODIFYs must run before the MODIFY that gives K its new expression.
    ClickHouse rejects an expression that closes a cycle. K's new expression
    closes one through column P when it reads a column that leads to P, and
    P's old expression reads a column that leads back to K, which P's new
    expression no longer reads. "Leads to" follows reads that both the old
    and the new expression of their column have, so the path exists in every
    intermediate state and only P's MODIFY breaks it. On the way to P it also
    follows the reads of ``added`` columns: the MODIFY runs after the ADD of
    every added column its expression reads through them. Every such P is
    read by K's new expression through the new schema, so these edges can't
    form a cycle unless the new schema has one.

    Such a K, P and every column between them lie on a cycle of old and new
    reads, so the search starts from the old reads that P drops and keeps to
    the columns on such cycles (#789). Beyond work linear in the reads, it
    searches those columns once for each old read that a P drops, and once
    more for each such read and P when the first search finds a K: a deep
    chain of defaults costs no more than a short one, unless many dropped
    reads lead into the same long part of a cycle. Beyond the result, memory
    stays linear in the reads.
    """
    cyclic = _on_cycles(reads, old_reads)
    # Column -> the columns that lead to it, the first step from K excluded.
    leads_from: dict[str, list[str]] = {}
    for column, column_reads in reads.items():
        if column not in cyclic:
            continue
        follow = column in added
        for read in column_reads:
            if read in cyclic and (follow or read in old_reads.get(column, ())):
                leads_from.setdefault(read, []).append(column)

    def closure(start: str, step: Callable[[str], Iterable[str]]) -> set[str]:
        seen = {start}
        pending = [start]
        while pending:
            for other in step(pending.pop()):
                if other in cyclic and other not in seen:
                    seen.add(other)
                    pending.append(other)
        return seen

    def stable_reads(column: str) -> Iterable[str]:
        return reads.get(column, set()) & old_reads.get(column, set())

    # Dropped read -> the breakers that drop it. Each closure is searched,
    # used and let go, so the searches need memory linear in the reads.
    dropped_by: dict[str, list[str]] = {}
    for breaker in sorted(modified):
        if breaker not in cyclic:
            continue
        for dropped in old_reads.get(breaker, ()):
            if dropped not in reads.get(breaker, ()) and dropped in cyclic:
                dropped_by.setdefault(dropped, []).append(breaker)
    released: dict[str, dict[str, None]] = {}
    for dropped, breakers in dropped_by.items():
        back = closure(dropped, stable_reads)
        for breaker in breakers:
            leads_to_breaker: set[str] | None = None
            for key in back:
                if key == breaker or key not in modified:
                    continue
                if leads_to_breaker is None:
                    leads_to_breaker = closure(breaker, lambda column: leads_from.get(column, ()))
                if not leads_to_breaker.isdisjoint(reads.get(key, ())):
                    released.setdefault(key, {})[breaker] = None
    return {key: list(breakers) for key, breakers in released.items()}


def _on_cycles(reads: dict[str, set[str]], old_reads: dict[str, set[str]]) -> set[str]:
    """The columns on a cycle of ``reads`` and ``old_reads`` together, or on a path between two.

    It is what is left after taking away, again and again, every column that
    reads none of the rest or that none of the rest reads.
    """
    reads_of: dict[str, set[str]] = {}
    read_by: dict[str, set[str]] = {}
    for graph in (reads, old_reads):
        for column, column_reads in graph.items():
            for read in column_reads:
                reads_of.setdefault(column, set()).add(read)
                read_by.setdefault(read, set()).add(column)
    left = {column for column in reads_of if column in read_by}
    outs = {column: len(reads_of[column] & left) for column in left}
    ins = {column: len(read_by[column] & left) for column in left}
    pending = [column for column in left if outs[column] == 0 or ins[column] == 0]
    while pending:
        column = pending.pop()
        if column not in left:
            continue
        left.discard(column)
        for read in reads_of.get(column, ()):
            if read in left:
                ins[read] -= 1
                if ins[read] == 0:
                    pending.append(read)
        for other in read_by.get(column, ()):
            if other in left:
                outs[other] -= 1
                if outs[other] == 0:
                    pending.append(other)
    return left


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
    order. A RENAME COLUMN keeps its column on the graph under the new name
    (``_renamed_columns``). A table is left out, and keeps its sorted order,
    when a rename in ``renames`` is one ``_renamed_columns`` does not model,
    when one of its expressions is not plain (``_plain_reads``), when a
    statement's key could
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
    renamed_ids, renamed_excluded = _renamed_columns(renames, previous, next_)
    excluded |= renamed_excluded
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
    old_plain = {table: _renamed_graph(graph, renamed_ids) for table, graph in old_plain.items()}
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
        # The columns whose reads the replay changes: the others keep their old reads throughout.
        changed = {
            ids[index] or ""
            for index in members
            if index in changes or statements[index].type == "alter_table_drop_column"
        }
        replay = _DefaultReplay(initial.get(table, []), 8 * total + 1024, changed)
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


def _renamed_columns(
    renames: Sequence[ColumnRenameSuggestion],
    previous: Sequence[SchemaDefinition],
    next_: Sequence[SchemaDefinition],
) -> tuple[dict[str, str], set[str]]:
    """How the cycle repair sees the ``renames`` (#827).

    ClickHouse rewrites every DEFAULT, MATERIALIZED and ALIAS expression that
    reads a renamed column to its new name, so a RENAME COLUMN releases the
    old name and provides the new one, and the column keeps its reads and
    readers. The first value maps each old ``_column_id`` to the new one,
    which the old expressions are read with. A rename that this does not
    model leaves its table out (the second value): one whose old name is
    still a column after the plan or whose new name was one before it, a
    name in two renames of the table, a name with a ``.`` (ClickHouse renames
    nested columns differently), or a keyword or literal word (in any case:
    ClickHouse 26.3 rewrites a read of a column renamed to ``true`` as the
    literal ``true``, and one renamed to ``not`` as the operator).
    """

    def names(definitions: Sequence[SchemaDefinition]) -> dict[str, set[str]]:
        return {
            _table_id(definition.database, definition.name): {
                column.name for column in definition.columns
            }
            for definition in definitions
            if isinstance(definition, TableDefinition)
        }

    def modelled(name: str) -> bool:
        lower = name.lower()
        return "." not in name and lower not in _LITERAL_WORDS and lower not in _EXPRESSION_KEYWORDS

    before = names(previous)
    after = names(next_)
    ids: dict[str, str] = {}
    excluded: set[str] = set()
    seen: dict[str, set[str]] = {}
    for rename in renames:
        table = _table_id(rename.database, rename.table)
        used = seen.setdefault(table, set())
        old_names = before.get(table)
        new_names = after.get(table)
        clean = (
            modelled(rename.from_)
            and modelled(rename.to)
            and old_names is not None
            and new_names is not None
            and rename.from_ in old_names
            and rename.to not in old_names
            and rename.to in new_names
            and rename.from_ not in new_names
            and rename.from_ not in used
            and rename.to not in used
        )
        used.update((rename.from_, rename.to))
        if not clean:
            excluded.add(table)
        ids[f"{table}\x00{rename.from_}"] = f"{table}\x00{rename.to}"
    return ids, excluded


def _renamed_graph(graph: dict[str, set[str]], ids: dict[str, str]) -> dict[str, set[str]]:
    """``graph`` with the columns ``ids`` renames under their new names."""
    if not ids:
        return graph
    return {
        ids.get(column, column): {ids.get(read, read) for read in reads}
        for column, reads in graph.items()
    }


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
            cycle = replay.closed_cycle(column, change) if change is not None else _NO_CYCLE
            if cycle is None:
                return None
            if cycle.columns:
                candidates = sorted(
                    j
                    for other in cycle.columns
                    if other != column
                    for j in changing.get(other, ())
                    if j not in placed and group_of[j] != group
                )
                if not replay.spend(len(cycle.columns) + len(candidates)):
                    return None
                breaker: int | None = None
                for j in candidates:
                    if not any(
                        cycle.has(read) and read not in changes[j]
                        for read in replay.reads(columns[j] or "") or ()
                    ):
                        continue
                    waits = _waits_for(
                        _WaitGraph(prerequisites, extra, dependents, groups, group_of),
                        j,
                        target,
                        placed=placed,
                        replay=replay,
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


class _WaitGraph:
    """The statement graph ``_waits_for`` searches."""

    def __init__(
        self,
        prerequisites: list[list[int]],
        extra: dict[int, list[int]],
        dependents: dict[int, list[int]],
        groups: list[list[int]],
        group_of: list[int],
    ) -> None:
        self.prerequisites = prerequisites
        self.extra = extra
        # The statements that wait for each one, across groups (``extra`` included).
        self.dependents = dependents
        self.groups = groups
        self.group_of = group_of


def _waits_for(
    graph: _WaitGraph,
    start: int,
    target: int,
    *,
    placed: set[int],
    replay: _DefaultReplay,
) -> bool | None:
    """Whether statement ``start`` runs after ``target`` through ``prerequisites`` and ``extra``.

    None when ``replay`` runs out of work. A ``placed`` statement has run, so
    it does not wait for ``target``, which has not. ``target`` is ready to
    run, so every statement that waits for it is still to run. The search runs
    from both ends, widening the smaller frontier (in turns on a tie): down
    the prerequisites of ``start``, and up the statements that wait for
    ``target``, where the members of a group wait for each other. Many
    breakers can wait for one long chain of statements that does not reach
    ``target``; the other end then stops it early. Each prerequisite,
    dependent or group member it looks at uses one unit of the replay's work.
    """
    down = {start}
    up = {target}
    up_groups: set[int] = set()
    down_front, up_front = [start], [target]
    widen_down = False
    while down_front and up_front:
        if len(down_front) == len(up_front):
            widen_down = not widen_down
        else:
            widen_down = len(down_front) < len(up_front)
        front: list[int] = []
        if widen_down:
            for index in down_front:
                for others in (graph.prerequisites[index], graph.extra.get(index, ())):
                    for other in others:
                        if not replay.spend():
                            return None
                        if other in up:
                            return True
                        if other in placed or other in down:
                            continue
                        down.add(other)
                        front.append(other)
            down_front = front
        else:
            for index in up_front:
                group = graph.group_of[index]
                members = () if group in up_groups else graph.groups[group]
                up_groups.add(group)
                for others in (members, graph.dependents.get(index, ())):
                    for other in others:
                        if not replay.spend():
                            return None
                        if other in down:
                            return True
                        if other in up:
                            continue
                        up.add(other)
                        front.append(other)
            up_front = front
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


class _ClosedCycle:
    """A cycle ``closed_cycle`` found.

    ``columns`` holds ``column`` and every column on the cycle that a
    statement changes, among others; it leaves out the links of a chain of
    unchanged columns that each read one column.
    """

    def __init__(self, columns: list[str], has: Callable[[str], bool]) -> None:
        self.columns = columns
        # Whether a read of a column of ``columns`` (other than ``column``) is on the cycle.
        self.has = has


_NO_CYCLE = _ClosedCycle([], lambda _read: False)

# The landing of a column ``_land`` is still following.
_ON_PATH = -2


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

    Only the ``changed`` columns are assigned new reads; the others keep
    their old reads. A walk down the reads skips a chain of unchanged columns
    that each read one column (``_land``) and remembers where it ends, which
    never changes. Many cycles can run through one long chain (#829); each
    cycle then costs the columns around the chain, not its length.
    """

    def __init__(self, initial: list[tuple[str, set[str]]], budget: int, changed: set[str]) -> None:
        self._number: dict[str, int] = {}
        self._names: list[str] = []
        self._reads: list[list[int] | None] = []
        self._readers: list[dict[int, None]] = []
        self._changed = changed
        self._fixed: list[bool] = []
        # Where a walk that reads a column lands (``_land``), or -1 until it is known.
        self._landing: list[int] = []
        # Marks with an epoch per search, instead of a set per search.
        self._down: list[int] = []
        self._up: list[int] = []
        self._seen: list[int] = []
        self._inside: list[int] = []
        self._epoch = 0
        self._gather = 0
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
        self._fixed.append(column not in self._changed)
        self._landing.append(-1)
        self._down.append(0)
        self._up.append(0)
        self._seen.append(0)
        self._inside.append(0)
        return number

    def _numbered(self, columns: Iterable[str]) -> list[int]:
        # Columns are numbered in code point order within each set, so both ports number them alike.
        ordered = sorted(columns)
        self._left -= len(ordered)
        return sorted(self._of(column) for column in ordered)

    def _land(self, column: int) -> int:
        """The column a walk that reads ``column`` lands on.

        ``column`` itself, or, when no statement changes it and it reads one
        column, where that read lands. Those reads never change, so the answer
        is kept. Each link it follows the first time uses one unit; the caller
        checks the budget. A cycle among those reads (an old schema ClickHouse
        refuses) uses up the work, so the table keeps its sorted order.
        """
        path: list[int] = []
        at = column
        while True:
            known = self._landing[at]
            if known >= 0:
                at = known
                break
            if known == _ON_PATH:
                for link in path:
                    self._landing[link] = -1
                self._left = -1
                return at
            reads = self._reads[at]
            if not self._fixed[at] or reads is None or len(reads) != 1 or self._left < 0:
                self._landing[at] = at
                break
            path.append(at)
            self._landing[at] = _ON_PATH
            self._left -= 1
            at = reads[0]
        for link in path:
            self._landing[link] = at
        return at

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

    def closed_cycle(self, column: str, reads: set[str]) -> _ClosedCycle | None:  # noqa: PLR0915
        """The cycle through ``column`` that giving it ``reads`` would close, or none (no columns).

        It changes nothing, and returns None when the replay has used up its
        work.
        """
        target = self._of(column)
        current = set(self._reads[target] or ())
        self._left -= len(current)
        numbered = self._numbered(reads)
        if self._left < 0:
            return None
        self._gather += 1
        mark = self._gather
        seen, inside = self._seen, self._inside
        columns: list[str] = []
        for read in numbered:
            if read in current:
                continue
            hit = self._reaches(read, target)
            if hit is None:
                return None
            if not hit:
                continue
            if not columns:
                seen[target] = mark
                inside[target] = mark
                columns.append(column)
            # The columns this read reaches (``seen``), walked depth first; one
            # is on the cycle (``inside``) when one of its reads lands on the cycle.
            # A column still on the walk is marked ``-mark``: meeting it again
            # means the state holds a cycle (an old schema ClickHouse refuses),
            # so the table keeps its sorted order.
            start = self._land(read)
            if self._left < 0:
                return None
            if seen[start] == mark:
                continue
            seen[start] = mark
            inside[start] = -mark
            stack, position, on_cycle = [start], [0], [False]
            while stack:
                top = len(stack) - 1
                at = stack[top]
                at_reads = self._reads[at] or ()
                index = position[top]
                if index < len(at_reads):
                    position[top] = index + 1
                    self._left -= 1
                    reached = self._land(at_reads[index])
                    if self._left < 0:
                        return None
                    if seen[reached] != mark:
                        seen[reached] = mark
                        inside[reached] = -mark
                        stack.append(reached)
                        position.append(0)
                        on_cycle.append(False)
                    elif inside[reached] == mark:
                        on_cycle[top] = True
                    elif inside[reached] == -mark:
                        self._left = -1
                        return None
                    continue
                stack.pop()
                position.pop()
                inside[at] = 0
                if not on_cycle.pop():
                    continue
                inside[at] = mark
                columns.append(self._names[at])
                if top > 0:
                    on_cycle[top - 1] = True

        def has(name: str) -> bool:
            # A read of a column on the cycle is on it when it lands on the cycle.
            number = self._number.get(name)
            return number is not None and inside[self._land(number)] == mark

        return _ClosedCycle(columns, has)

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
                    for read in self._reads[column] or ():
                        self._left -= 1
                        reached = self._land(read)
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
