"""Class-name and attribute-name rendering for codegen.

1:1 port of ``packages/plugin-codegen/src/naming.ts`` adapted for Python:

- Class names use Pascal/Camel/raw styles plus a ``Row`` suffix
  (e.g. ``EventsUserActionsRow`` for ``events.user_actions``).
- Attribute names: Python identifier rules differ from JS (no ``$``).
  Non-identifier column names get sanitized with an underscore prefix; if
  even that fails, we fall back to ``f_<safe>``.
"""

from __future__ import annotations

import keyword
import re
from collections.abc import Sequence

from chkit.core import (
    MaterializedViewDefinition,
    TableDefinition,
    ViewDefinition,
)
from chkit_plugin_codegen.options import TableNameStyle
from chkit_plugin_codegen.types import ResolvedTableName

_NON_ALNUM = re.compile(r"[^A-Za-z0-9]+")
_NON_IDENT = re.compile(r"[^A-Za-z0-9_]")
_MULTI_UNDERSCORE = re.compile(r"_+")
_PY_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _to_words(value: str) -> list[str]:
    return [part for part in _NON_ALNUM.split(value) if part]


def _pascal_case(value: str) -> str:
    words = _to_words(value)
    if not words:
        return "Item"
    return "".join(part[:1].upper() + part[1:] for part in words)


def _camel_case(value: str) -> str:
    words = _to_words(value)
    if not words:
        return "item"
    head, *tail = words
    return head.lower() + "".join(part[:1].upper() + part[1:] for part in tail)


def _raw_case(value: str) -> str:
    sanitized = _NON_IDENT.sub("_", value)
    sanitized = _MULTI_UNDERSCORE.sub("_", sanitized).strip("_")
    return sanitized or "item"


def _is_valid_python_identifier(value: str) -> bool:
    return bool(_PY_IDENT.match(value)) and not keyword.iskeyword(value)


def render_attribute_name(name: str) -> str:
    """Map a ClickHouse column name to a valid Python attribute identifier.

    Returns a tuple-free string. Pydantic models then declare the field via
    ``Field(..., alias="<original-name>")`` only when the rendered name differs
    from the original (the caller handles that).
    """
    if _is_valid_python_identifier(name):
        return name
    sanitized = _NON_IDENT.sub("_", name)
    sanitized = _MULTI_UNDERSCORE.sub("_", sanitized).strip("_")
    if not sanitized:
        return "field_"
    if sanitized[0].isdigit():
        sanitized = f"f_{sanitized}"
    if not _is_valid_python_identifier(sanitized):
        sanitized = f"f_{sanitized}"
    return sanitized


def _base_class_name(
    definition: TableDefinition | ViewDefinition | MaterializedViewDefinition,
    style: TableNameStyle,
) -> str:
    combined = f"{definition.database}_{definition.name}"
    if style == "raw":
        candidate = f"{_raw_case(combined)}_row"
        return candidate if _is_valid_python_identifier(candidate) else f"_{candidate}"
    if style == "camel":
        return f"{_camel_case(combined)}Row"
    return f"{_pascal_case(combined)}Row"


def resolve_table_names(
    definitions: Sequence[TableDefinition | ViewDefinition | MaterializedViewDefinition],
    style: TableNameStyle,
) -> list[ResolvedTableName]:
    """Compute the per-table emitted class names, deduplicating collisions."""
    bases: list[tuple[TableDefinition | ViewDefinition | MaterializedViewDefinition, str]] = [
        (defn, _base_class_name(defn, style)) for defn in definitions
    ]
    counts: dict[str, int] = {}
    resolved: list[ResolvedTableName] = []
    for definition, base in bases:
        count = counts.get(base, 0) + 1
        counts[base] = count
        class_name = base if count == 1 else f"{base}_{count}"
        resolved.append(ResolvedTableName(definition=definition, class_name=class_name))
    return resolved


__all__ = [
    "render_attribute_name",
    "resolve_table_names",
]
