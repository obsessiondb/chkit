"""Object dependencies between schema definitions, for ordering migration DDL.

1:1 port of ``packages/core/src/object-dependencies.ts`` (#231).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping, Sequence, Set
from dataclasses import dataclass, field
from typing import Final, Literal, TypeAlias, TypeVar

from chkit.core.canonical import definition_key
from chkit.core.column_default import parse_column_default
from chkit.core.model import (
    DictionaryDefinition,
    MaterializedViewDefinition,
    SchemaDefinition,
    TableDefinition,
    ViewDefinition,
)
from chkit.core.sql_lexer import (
    SQLToken,
    identifier_name,
    is_trivia,
    string_literal_value,
    tokenize_sql,
)

# Definition key -> keys of the other definitions in the same set it references.
DependencyGraph: TypeAlias = Mapping[str, Set[str]]

_T = TypeVar("_T")

# Functions whose first argument names a dictionary or Join table, plus the
# dictionary() table function.
_OBJECT_NAME_FUNCTION: Final[re.Pattern[str]] = re.compile(
    r"(dictGet\w*|dictHas|dictIsIn|joinGet|joinGetOrNull|dictionary)", re.IGNORECASE
)
# `WITH TOTALS`, `WITH ROLLUP`, `WITH CUBE`, `WITH FILL` and `WITH TIES` are
# modifiers, not the start of a WITH list.
_WITH_MODIFIER: Final[frozenset[str]] = frozenset({"totals", "rollup", "cube", "fill", "ties"})


@dataclass(frozen=True, slots=True)
class _ObjectReference:
    database: str
    name: str


@dataclass(slots=True)
class _PendingCte:
    name: str
    body_at: int


@dataclass(slots=True)
class _QueryScope:
    """One parenthesis level of a SQL text; the whole text is the outermost level."""

    # The level holds a query, so `FROM`/`JOIN` name tables here.
    query: bool
    # CTE names declared by this level's WITH list so far.
    cte_names: set[str] = field(default_factory=set[str])
    # This level's WITH list, from `WITH` to its SELECT.
    with_list: Literal["none", "open", "recursive"] = "none"
    # A CTE whose body opens at token `body_at`; its name is declared when that body closes.
    pending_cte: _PendingCte | None = None
    # On a CTE body: the name the enclosing level declares when this body closes.
    declares_on_close: str | None = None


def build_dependency_graph(definitions: Sequence[SchemaDefinition]) -> dict[str, set[str]]:
    """Edges from every definition to the definitions it reads, restricted to the given set.

    Expects canonical definitions (``canonicalize_definitions``).
    """
    keys_by_name: dict[str, list[str]] = {}
    for definition in definitions:
        keys_by_name.setdefault(f"{definition.database}.{definition.name}", []).append(
            definition_key(definition)
        )

    graph: dict[str, set[str]] = {}
    for definition in definitions:
        key = definition_key(definition)
        edges: set[str] = set()
        for ref in _definition_references(definition):
            for target in keys_by_name.get(f"{ref.database}.{ref.name}", []):
                if target != key:
                    edges.add(target)
        graph[key] = edges
    return graph


def order_by_dependencies(
    items: Sequence[_T],
    key_of: Callable[[_T], str],
    prerequisites_of: Callable[[str], Iterable[str]],
) -> list[_T]:
    """Stable topological order.

    Items whose prerequisites are all placed keep their input order; an item
    moves behind every prerequisite found in ``items``. Members of a dependency
    cycle stay together in input order, and whatever depends on the cycle
    comes after all of them.
    """
    indexes_by_key: dict[str, list[int]] = {}
    for index, item in enumerate(items):
        indexes_by_key.setdefault(key_of(item), []).append(index)
    prerequisites: list[list[int]] = []
    for index, item in enumerate(items):
        found: dict[int, None] = {}
        for key in prerequisites_of(key_of(item)):
            for other in indexes_by_key.get(key, []):
                if other != index:
                    found[other] = None
        prerequisites.append(list(found))

    components = _strongly_connected_components(prerequisites)
    component_of = [0] * len(items)
    for component, members in enumerate(components):
        for member in members:
            component_of[member] = component

    placed: set[int] = set()
    ordered: list[_T] = []
    # Components sorted by their earliest member keep cycle-free input order.
    pending = sorted(
        ((component, sorted(members)) for component, members in enumerate(components)),
        key=lambda entry: entry[1][0] if entry[1] else 0,
    )
    while pending:
        ready_at = next(
            (
                position
                for position, (component, members) in enumerate(pending)
                if all(
                    component_of[other] == component or component_of[other] in placed
                    for member in members
                    for other in prerequisites[member]
                )
            ),
            None,
        )
        if ready_at is None:
            msg = "order_by_dependencies: no component is ready, but the component graph is acyclic"
            raise RuntimeError(msg)
        component, members = pending.pop(ready_at)
        placed.add(component)
        ordered.extend(items[member] for member in members)
    return ordered


def invert_dependency_graph(graph: DependencyGraph) -> dict[str, set[str]]:
    """Reverses every edge: key -> keys of the definitions that reference it."""
    inverted: dict[str, set[str]] = {}
    for key, targets in graph.items():
        for target in targets:
            inverted.setdefault(target, set()).add(key)
    return inverted


def _definition_references(definition: SchemaDefinition) -> list[_ObjectReference]:
    if isinstance(definition, ViewDefinition):
        return _sql_references(definition.as_, definition.database)
    if isinstance(definition, MaterializedViewDefinition):
        depends_on = (definition.refresh.depends_on if definition.refresh else None) or []
        return [
            *_sql_references(definition.as_, definition.database),
            _ObjectReference(definition.to.database, definition.to.name),
            *(_ObjectReference(dep.database, dep.name) for dep in depends_on),
        ]
    if isinstance(definition, TableDefinition):
        return _table_references(definition)
    return _dictionary_source_references(definition)


def _table_references(definition: TableDefinition) -> list[_ObjectReference]:
    # Column default expressions, such as
    # `SQLExpression(expression="dictGet('db.dict', 'name', id)")`.
    references: list[_ObjectReference] = []
    for column in definition.columns:
        if column.default is None:
            continue
        parsed = parse_column_default(column.default)
        if parsed.kind == "expression":
            references.extend(_sql_references(parsed.sql, definition.database))
    return references


def _dictionary_source_references(definition: DictionaryDefinition) -> list[_ObjectReference]:
    # SOURCE(CLICKHOUSE(... TABLE 't' DB 'd' ...)) or SOURCE(CLICKHOUSE(... QUERY '...' ...)).
    tokens = _significant_tokens(definition.source)
    if len(tokens) < 2 or tokens[0].text.lower() != "clickhouse" or tokens[1].text != "(":  # noqa: PLR2004
        return []
    params: dict[str, str] = {}
    for i in range(2, len(tokens) - 1):
        key, value = tokens[i], tokens[i + 1]
        if key.kind != "identifier":
            continue
        text = string_literal_value(value)
        if text is not None:
            params[key.text.upper()] = text
    query = params.get("QUERY")
    if query is not None:
        return _sql_references(query, definition.database)
    table = params.get("TABLE")
    if table is None:
        return []
    return [_ObjectReference(params.get("DB", definition.database), table)]


def _sql_references(sql: str, own_database: str) -> list[_ObjectReference]:
    """Objects a SQL query or expression reads.

    Qualified ``db.name`` pairs anywhere, the name argument of
    dictGet-family/joinGet/dictionary(), and unqualified FROM/JOIN targets,
    resolved against ``own_database`` unless a CTE in scope has that name.
    """
    tokens = _significant_tokens(sql)
    root = _QueryScope(query=True)
    scopes = [root]
    references: list[_ObjectReference] = []
    for i, token in enumerate(tokens):
        text = token.text
        scope = scopes[-1]
        if text == "(":
            query = _text_at(tokens, i + 1).lower() in ("select", "with")
            # A CTE's column list is a parenthesis of its own; only the body declares.
            declares_on_close: str | None = None
            if scope.pending_cte is not None and scope.pending_cte.body_at == i:
                declares_on_close = scope.pending_cte.name
                scope.pending_cte = None
            scopes.append(_QueryScope(query=query, declares_on_close=declares_on_close))
            continue
        if text == ")":
            if len(scopes) == 1:
                continue
            scopes.pop()
            if scope.declares_on_close is not None:
                scopes[-1].cte_names.add(scope.declares_on_close)
            continue
        _track_with_list(tokens, i, scope)
        found = (
            _qualified_reference(tokens, i),
            _object_name_argument(tokens, i, own_database),
            _unqualified_table_target(tokens, i, own_database, scopes) if scope.query else None,
        )
        references.extend(reference for reference in found if reference is not None)
    return references


def _track_with_list(tokens: list[SQLToken], i: int, scope: _QueryScope) -> None:
    # `WITH a AS (…), b AS (…) SELECT …` declares the CTEs `a` and `b` for this
    # level and every level inside it. Each name takes effect when its body
    # closes: a CTE body that names its own CTE reads the real object, and only
    # `WITH RECURSIVE` lets a body see its own name. The list ends at the
    # level's SELECT, so a later `WINDOW w AS (…)` declares nothing.
    token = tokens[i]
    keyword = token.text.lower() if token.kind == "identifier" else ""
    nxt = _text_at(tokens, i + 1).lower()
    if keyword == "with":
        if nxt in _WITH_MODIFIER:
            scope.with_list = "none"
        else:
            scope.with_list = "recursive" if nxt == "recursive" else "open"
        return
    if keyword == "select":
        scope.with_list = "none"
        return
    name = identifier_name(token)
    if name is None or scope.with_list == "none":
        return
    previous = _text_at(tokens, i - 1).lower() if i > 0 else ""
    starts_entry = previous in ("with", "recursive", ",")
    body_at = _cte_body_start(tokens, i + 1) if starts_entry else None
    if body_at is None:
        return
    if scope.with_list == "recursive":
        scope.cte_names.add(name)
    else:
        scope.pending_cte = _PendingCte(name=name, body_at=body_at)


def _cte_body_start(tokens: list[SQLToken], after_name: int) -> int | None:
    # The `(` that opens a CTE body, after the CTE name: an optional column list
    # `(a, b)`, `AS`, an optional `MATERIALIZED`, then the body. Anything else,
    # such as `lower(x) AS alias`, is an expression alias, not a CTE.
    i = (
        _closing_parenthesis(tokens, after_name) + 1
        if _text_at(tokens, after_name) == "("
        else after_name
    )
    if _text_at(tokens, i).lower() != "as":
        return None
    i += 1
    if _text_at(tokens, i).lower() == "materialized":
        i += 1
    return i if _text_at(tokens, i) == "(" else None


def _closing_parenthesis(tokens: list[SQLToken], open_at: int) -> int:
    # Index of the `)` matching the `(` at `open_at`, or past the end when unbalanced.
    depth = 0
    for i in range(open_at, len(tokens)):
        text = tokens[i].text
        if text == "(":
            depth += 1
        elif text == ")":
            depth -= 1
            if depth == 0:
                return i
    return len(tokens)


def _qualified_reference(tokens: list[SQLToken], i: int) -> _ObjectReference | None:
    # `db.name`, with bare or quoted parts and any comments around the dot. A
    # pair right after another dot is a column path (`db.t.col`), not an object.
    if i + 2 >= len(tokens) or tokens[i + 1].text != ".":
        return None
    if i > 0 and tokens[i - 1].text == ".":
        return None
    database = identifier_name(tokens[i])
    name = identifier_name(tokens[i + 2])
    if database is None or name is None:
        return None
    return _ObjectReference(database, name)


def _object_name_argument(
    tokens: list[SQLToken], i: int, own_database: str
) -> _ObjectReference | None:
    # The first argument of dictGet and the other _OBJECT_NAME_FUNCTION calls:
    # a string (`dictGet('db.dict', …)`) or a bare or quoted name
    # (`dictGet(dict, …)`). ClickHouse resolves an unqualified one against the
    # current database; a qualified `db.dict` is found as a pair.
    token = tokens[i]
    if token.kind != "identifier" or _OBJECT_NAME_FUNCTION.fullmatch(token.text) is None:
        return None
    if _text_at(tokens, i + 1) != "(" or i + 2 >= len(tokens):
        return None
    argument = tokens[i + 2]
    value = string_literal_value(argument)
    if value is not None:
        return _parse_object_name(value, own_database)
    name = identifier_name(argument)
    after = _text_at(tokens, i + 3)
    if name is not None and after in (",", ")"):
        return _ObjectReference(own_database, name)
    return None


def _unqualified_table_target(
    tokens: list[SQLToken], i: int, own_database: str, scopes: list[_QueryScope]
) -> _ObjectReference | None:
    # `FROM name` / `JOIN name` in query context. Skips `ARRAY JOIN expr`,
    # `x IS [NOT] DISTINCT FROM y`, qualified names (found as pairs), table
    # functions (`numbers(10)`) and CTE names declared at this level or above.
    token = tokens[i]
    keyword = token.text.lower() if token.kind == "identifier" else ""
    if keyword not in ("from", "join"):
        return None
    previous = _text_at(tokens, i - 1).lower() if i > 0 else ""
    if keyword == "join" and previous == "array":
        return None
    if keyword == "from" and previous == "distinct":
        return None
    target = identifier_name(tokens[i + 1]) if i + 1 < len(tokens) else None
    after = _text_at(tokens, i + 2)
    if target is None or after in (".", "("):
        return None
    if any(target in scope.cte_names for scope in scopes):
        return None
    return _ObjectReference(own_database, target)


def _parse_object_name(value: str, own_database: str) -> _ObjectReference | None:
    # Mirrors ClickHouse's QualifiedTableName::tryParseFromString: one dot
    # splits database and name; no dot means the current database.
    parts = value.split(".")
    if any(len(part) == 0 for part in parts) or len(parts) > 2:  # noqa: PLR2004
        return None
    if len(parts) == 1:
        return _ObjectReference(own_database, parts[0])
    return _ObjectReference(parts[0], parts[1])


def _significant_tokens(sql: str) -> list[SQLToken]:
    return [token for token in tokenize_sql(sql) if not is_trivia(token)]


def _text_at(tokens: list[SQLToken], i: int) -> str:
    return tokens[i].text if 0 <= i < len(tokens) else ""


def _strongly_connected_components(edges: list[list[int]]) -> list[list[int]]:
    # Tarjan's algorithm over index-based edges (`edges[v]` = nodes v points to).
    counter = 0
    index: dict[int, int] = {}
    low_link: dict[int, int] = {}
    on_stack: set[int] = set()
    stack: list[int] = []
    components: list[list[int]] = []

    def visit(v: int) -> None:
        nonlocal counter
        index[v] = counter
        low_link[v] = counter
        counter += 1
        stack.append(v)
        on_stack.add(v)
        for w in edges[v]:
            if w not in index:
                visit(w)
                low_link[v] = min(low_link[v], low_link[w])
            elif w in on_stack:
                low_link[v] = min(low_link[v], index[w])
        if low_link[v] != index[v]:
            return
        component: list[int] = []
        while stack:
            w = stack.pop()
            on_stack.discard(w)
            component.append(w)
            if w == v:
                break
        components.append(component)

    for v in range(len(edges)):
        if v not in index:
            visit(v)
    return components
