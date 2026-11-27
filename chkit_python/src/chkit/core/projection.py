"""Projection helpers: SELECT vs index-only projections.

Port of ``packages/core/src/projection.ts`` (TS ``3f1db03``).
"""

from __future__ import annotations

from chkit.core.key_clause import split_top_level_comma
from chkit.core.model import ProjectionDefinition
from chkit.core.sql_lexer import iter_sql_tokens, js_trim
from chkit.core.sql_normalizer import normalize_sql_fragment
from chkit.core.sql_scan import strip_wrapping_parens


def is_index_projection(projection: ProjectionDefinition) -> bool:
    return projection.index is not None


def _space_after_commas(text: str) -> str:
    """ClickHouse prints one space after every argument separator.

    The input is read with the SQL lexer, so a comma in a string, quoted name
    or heredoc (``$$a,b$$``) is text and keeps its literal (#596).
    """
    out: list[str] = []
    after_comma = False
    for token in iter_sql_tokens(text):
        # Whitespace is already collapsed to single spaces by
        # normalize_sql_fragment, so a comma is followed by at most one space.
        piece = token.text
        if after_comma and token.kind == "whitespace" and piece.startswith(" "):
            piece = piece[1:]
        after_comma = token.kind == "punctuation" and token.text == ","
        out.append(", " if after_comma else piece)
    return "".join(out)


def normalize_projection_index(index: str) -> str:
    """Render an index expression list the way ClickHouse itself echoes it back.

    A single element is bare (``INDEX b``), several are a tuple
    (``INDEX (a, b)``). Both halves matter: ClickHouse rewrites ``INDEX (b)``
    to ``INDEX b``, so without this a pulled schema would drift against the
    live table forever; and it rejects ``INDEX a, b`` outright, so multiple
    elements must be parenthesized.

    Must be idempotent: it runs at canonicalize time and again at render time,
    and a canonical form that keeps changing makes every ``generate`` re-emit
    a drop + rebuild of the projection.
    """
    # Peel every redundant layer, not just one: ClickHouse reports `((a, b))`
    # back as `(a, b)`.
    expression = normalize_sql_fragment(index)
    stripped = strip_wrapping_parens(expression)
    while stripped != expression:
        expression = stripped
        stripped = strip_wrapping_parens(expression)

    parts = split_top_level_comma(expression)
    if len(parts) == 0:
        return ""
    # A lone element is the base case — recursing here would not terminate.
    if len(parts) == 1:
        return _space_after_commas(expression)
    # Each element is peeled too, since ClickHouse reports `(a, (b))` back as
    # `(a, b)` while keeping a genuine nested tuple like `(a, (b, c))`.
    return f"({', '.join(normalize_projection_index(part) for part in parts)})"


def canonicalize_projection(projection: ProjectionDefinition) -> ProjectionDefinition:
    if is_index_projection(projection):
        index = projection.index if projection.index is not None else ""
        return ProjectionDefinition(
            name=projection.name,
            index=normalize_projection_index(index),
            type=js_trim(projection.type) if projection.type is not None else None,
        )
    return ProjectionDefinition(
        name=projection.name,
        query=normalize_sql_fragment(projection.query)
        if projection.query is not None
        else None,
    )


def render_projection_body(projection: ProjectionDefinition) -> str:
    if is_index_projection(projection):
        index = projection.index if projection.index is not None else ""
        type_text = js_trim(projection.type) if projection.type is not None else ""
        return f"INDEX {normalize_projection_index(index)} TYPE {type_text}"
    return f"({projection.query})"
