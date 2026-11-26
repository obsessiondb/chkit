"""The columns an expression reads, for the column statement order."""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence

from chkit.core.column_default import parse_column_default
from chkit.core.model import ColumnRenameSuggestion, SchemaDefinition, TableDefinition
from chkit.core.sql_lexer import SQLToken, identifier_name, is_trivia, tokenize_sql

_BINARY_OPERATORS = frozenset(["+", "-", "*", "/", "%", "=", "<", ">"])
_PAIRED_OPERATORS = frozenset(["<=", ">=", "!=", "<>", "==", "||"])
# Bare words ClickHouse reads as literals (any case), whatever the columns.
_LITERAL_WORDS = frozenset(["false", "inf", "infinity", "nan", "null", "true"])
# Bare words that are not function names even before ``(``.
_NOT_FUNCTIONS = frozenset(["exists", "lambda", "select", "with"])
# Keywords of ClickHouse's expression grammar (operators, literals and the
# words of CASE, INTERVAL, DATE, CAST, EXTRACT, subqueries and windows): a
# bare one may not read a column of that name, so its expression is not
# plain, and neither is a call to one outside ``_KEYWORD_FUNCTIONS``. A quoted
# name reads such a column. Query clause and join words (``left``, ``right``,
# ``format``, ``offset``, ``settings``...) are not here: ClickHouse 26.3 reads a
# bare one as its column and a call to one as a function, and their clause
# uses (``... FORMAT JSON``, ``LIMIT 1 OFFSET 2``) follow an operand, which is
# not plain anyway. ``values`` is: from 26.4, ``(values(c))`` is a subquery
# over SQL-standard VALUES, and so is ``(values - 1)`` before 26.4.3.
_EXPRESSION_KEYWORDS = frozenset(
    [
        "all", "and", "any", "array", "as", "asc", "ascending", "between", "both", "by",
        "case", "cast", "collate", "columns", "current", "date", "desc", "descending",
        "distinct", "div", "else", "end", "escape", "except", "exists", "extract", "filter",
        "first", "following", "for", "from", "global", "ignore", "ilike", "in", "interval",
        "is", "lambda", "last", "leading", "like", "mod", "not", "nulls", "or", "order",
        "over", "partition", "position", "preceding", "range", "regexp", "replace",
        "respect", "row", "rows", "select", "substring", "then", "ties", "timestamp",
        "trailing", "trim", "unbounded", "values", "when", "where", "window", "with", "within",
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


def _column_default_reads(
    definitions: Sequence[SchemaDefinition],
    lambdas: bool = False,
    column_key_of: Callable[[str, str, str], str] | None = None,
) -> dict[str, set[str]]:
    """Column operation key to the keys of the same table's columns its default expression names.

    Or the same with the keys ``column_key_of`` gives. A name followed by
    ``(`` is a function call, not a column, and neither are the names
    ``_not_column_names`` finds. With ``lambdas``, the lambdas' own names read
    columns as well (``_lambda_reads``).
    """
    key_of = _column_key if column_key_of is None else column_key_of
    graph: dict[str, set[str]] = {}
    for definition in definitions:
        if not isinstance(definition, TableDefinition):
            continue
        database, table_name = definition.database, definition.name
        names = {column.name for column in definition.columns}
        for column in definition.columns:
            if column.default is None:
                continue
            parsed = parse_column_default(column.default)
            if parsed.kind != "expression":
                continue
            read: set[str] = set()
            found = _dotted_names(parsed.sql, names)
            for name in [*found, *_lambda_reads(parsed.sql, names)] if lambdas else found:
                if name != column.name:
                    read.add(key_of(database, table_name, name))
            graph[key_of(database, table_name, column.name)] = read
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
    """Table TTL id to the ids of the table's columns the TTL names.

    The TTL is read with the same rules as a column's default expression
    (``_dotted_names``).
    """
    graph: dict[str, set[str]] = {}
    for definition in definitions:
        if not isinstance(definition, TableDefinition) or definition.ttl is None:
            continue
        names = {column.name for column in definition.columns}
        graph[_ttl_object_id(definition.database, definition.name)] = {
            _column_object_id(definition.database, definition.name, name)
            for name in _dotted_names(definition.ttl, names)
        }
    return graph


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


def _lambda_reads(sql: str, columns: set[str]) -> list[str]:
    """The columns the lambdas in ``sql`` name where ``_dotted_names`` skips them (#768).

    ClickHouse's ALTER check for cyclic defaults (code 174) reads a lambda's
    parameters as columns, even one its body never uses, and a use with
    ``.name`` parts as the longest leading part that is a column: ``w -> w.a``
    reads the column ``w.a`` or ``w``, never ``a`` (#799).
    """
    tokens = [token for token in tokenize_sql(sql) if not is_trivia(token)]
    found: list[str] = []
    count = len(tokens)
    for i, token in enumerate(tokens):
        following = tokens[i + 1] if i + 1 < len(tokens) else None
        if following is None or token.text != "-" or following.text != ">":
            continue
        if token.end != following.start:
            continue
        params = _lambda_parameters(tokens, i)
        if params is None:
            continue
        names = params[0]
        found.extend(name for name in sorted(names) if name in columns)
        end = _group_end(tokens, i + 2)
        j = i + 2
        while j < end:
            name = identifier_name(tokens[j])
            if name is not None and name in names and tokens[j - 1].text != ".":
                run = [name]
                while j + 2 < count and tokens[j + 1].text == ".":
                    part = identifier_name(tokens[j + 2])
                    if part is None:
                        break
                    run.append(part)
                    j += 2
                column = _longest_column_prefix(run, columns)
                if column is not None:
                    found.append(column)
            j += 1
    return found


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


def _column_key(database: str, table: str, column: str) -> str:
    return f"table:{database}.{table}:column:{column}"


# Ids of the objects the column statements change. Unlike operation keys,
# two objects never share one: table ``t:column:x`` and column ``x:column:a``
# of ``t`` give the same key (#801).
def _column_object_id(database: str, table: str, column: str) -> str:
    return json.dumps(["column", database, table, column])


def _ttl_object_id(database: str, table: str) -> str:
    return json.dumps(["ttl", database, table])


def _rename_object_id(rename: ColumnRenameSuggestion) -> str:
    return json.dumps(["rename", rename.database, rename.table, rename.from_, rename.to])


def _table_id(database: str, table: str) -> str:
    """The identity of a table: its database and name, which a column key does not carry."""
    return f"{database}\x00{table}"


def column_rename_key(rename: ColumnRenameSuggestion) -> str:
    """Key of the RENAME COLUMN operation of ``rename``."""
    return f"table:{rename.database}.{rename.table}:column_rename:{rename.from_}:{rename.to}"
