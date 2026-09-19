"""Projection helpers: SELECT vs index-only projections.

Port of ``packages/core/src/projection.ts`` (TS ``3f1db03``).
"""

from __future__ import annotations

from chkit.core.key_clause import split_top_level_comma
from chkit.core.model import ProjectionDefinition
from chkit.core.sql_normalizer import normalize_sql_fragment


def is_index_projection(projection: ProjectionDefinition) -> bool:
    return projection.index is not None


def _strip_wrapping_parens(text: str) -> str:
    if not (text.startswith("(") and text.endswith(")")):
        return text

    # Only strip when the leading paren closes at the very end, so `(a), (b)`
    # keeps both groups. Parens inside quoted identifiers and string literals
    # are text, not nesting — `` (`weird)name`) `` is still a single wrapped
    # expression.
    depth = 0
    quote: str | None = None
    for i, char in enumerate(text):
        if quote is not None:
            if char == quote and (i == 0 or text[i - 1] != "\\"):
                quote = None
            continue
        if char in ("'", '"', "`"):
            quote = char
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return text[1:-1].strip() if i == len(text) - 1 else text
    return text


def _space_after_commas(text: str) -> str:
    """ClickHouse prints one space after every argument separator."""
    out: list[str] = []
    quote: str | None = None
    i = 0
    while i < len(text):
        char = text[i]
        if quote is not None:
            out.append(char)
            if char == quote and (i == 0 or text[i - 1] != "\\"):
                quote = None
            i += 1
            continue
        if char in ("'", '"', "`"):
            quote = char
            out.append(char)
            i += 1
            continue
        # Whitespace is already collapsed to single spaces by
        # normalize_sql_fragment, so a comma is followed by at most one space.
        if char == ",":
            out.append(", ")
            if i + 1 < len(text) and text[i + 1] == " ":
                i += 1
            i += 1
            continue
        out.append(char)
        i += 1
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
    stripped = _strip_wrapping_parens(expression)
    while stripped != expression:
        expression = stripped
        stripped = _strip_wrapping_parens(expression)

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
            type=projection.type.strip() if projection.type is not None else None,
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
        type_text = projection.type.strip() if projection.type is not None else ""
        return f"INDEX {normalize_projection_index(index)} TYPE {type_text}"
    return f"({projection.query})"
