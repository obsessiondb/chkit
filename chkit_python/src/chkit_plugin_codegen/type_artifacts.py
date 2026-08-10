"""Map ClickHouse column types to Python type expressions and emit Pydantic models.

Python equivalent of ``packages/plugin-codegen/src/generators/type-artifacts.ts``.
The TS version emits TypeScript types + optional Zod schemas; we emit Pydantic
``BaseModel`` subclasses (one per table) which cover both static typing AND
runtime validation in a single shape.

Mapping summary (CH → Python):

- String / FixedString / Date / DateTime / UUID / IPv4 / IPv6 / Enum / Decimal → str
- Int8..Int32, UInt8..UInt32 → int; Float32, Float64, BFloat16 → float
- Int64 / UInt64 / Int128 / UInt128 / Int256 / UInt256 → int or str
  (configurable via ``bigint_mode``)
- Bool / Boolean → bool
- Nullable(T) → T | None
- LowCardinality(T) → maps T (no wrapping)
- Array(T) → list[T]
- Map(K, V) → dict[K, V]
- Tuple(T1, T2, ...) → tuple[T1, T2, ...]
- SimpleAggregateFunction(_, T) → T
- JSON → dict[str, Any]
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from chkit.core import (
    ColumnDefinition,
    DictionaryDefinition,
    MaterializedViewDefinition,
    SchemaDefinition,
    TableDefinition,
    ViewDefinition,
    canonicalize_definitions,
)
from chkit_plugin_codegen.errors import UnsupportedTypeError
from chkit_plugin_codegen.naming import (
    render_attribute_name,
    resolve_table_names,
)
from chkit_plugin_codegen.options import (
    BigIntMode,
    CodegenOptions,
    PluginConfig,
    normalize_codegen_options,
)
from chkit_plugin_codegen.types import CodegenFinding, ResolvedTableName

_LARGE_INTEGER_TYPES: Final[frozenset[str]] = frozenset(
    {"Int64", "UInt64", "Int128", "UInt128", "Int256", "UInt256"}
)
_NUMBER_INT_TYPES: Final[frozenset[str]] = frozenset(
    {"Int8", "Int16", "Int32", "UInt8", "UInt16", "UInt32"}
)
_NUMBER_FLOAT_TYPES: Final[frozenset[str]] = frozenset(
    {"Float32", "Float64", "BFloat16"}
)
_STRING_TYPES: Final[frozenset[str]] = frozenset(
    {
        "String",
        "FixedString",
        "Date",
        "Date32",
        "DateTime",
        "DateTime64",
        "UUID",
        "IPv4",
        "IPv6",
        "Enum",
        "Enum8",
        "Enum16",
        "Decimal",
        "Decimal32",
        "Decimal64",
        "Decimal128",
        "Decimal256",
    }
)
_BOOLEAN_TYPES: Final[frozenset[str]] = frozenset({"Bool", "Boolean"})


@dataclass(frozen=True, slots=True)
class _ParsedType:
    base: str
    args: list[str]


@dataclass(frozen=True, slots=True)
class _Resolved:
    py_type: str
    nullable: bool


@dataclass(frozen=True, slots=True)
class MapColumnTypeResult:
    py_type: str
    nullable: bool
    finding: CodegenFinding | None = None


@dataclass(frozen=True, slots=True)
class GenerateTypeArtifactsOutput:
    content: str
    out_file: str
    declaration_count: int
    findings: list[CodegenFinding]


def _split_top_level_args(inner: str) -> list[str]:
    args: list[str] = []
    depth = 0
    start = 0
    for i, ch in enumerate(inner):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            args.append(inner[start:i].strip())
            start = i + 1
    last = inner[start:].strip()
    if last:
        args.append(last)
    return args


def _parse_clickhouse_type(type_str: str) -> _ParsedType:
    trimmed = type_str.strip()
    paren = trimmed.find("(")
    if paren < 0:
        return _ParsedType(base=trimmed, args=[])
    closing = trimmed.rfind(")")
    if closing <= paren:
        return _ParsedType(base=trimmed, args=[])
    base = trimmed[:paren]
    inner = trimmed[paren + 1 : closing]
    if not inner.strip():
        return _ParsedType(base=base, args=[])
    return _ParsedType(base=base, args=_split_top_level_args(inner))


def _map_scalar(base: str, bigint_mode: BigIntMode) -> str | None:
    if base in _STRING_TYPES:
        return "str"
    if base in _BOOLEAN_TYPES:
        return "bool"
    if base in _NUMBER_INT_TYPES:
        return "int"
    if base in _NUMBER_FLOAT_TYPES:
        return "float"
    if base in _LARGE_INTEGER_TYPES:
        return "str" if bigint_mode == "str" else "int"
    return None


def _resolve_inner(type_str: str, bigint_mode: BigIntMode) -> _Resolved | None:  # noqa: PLR0911, PLR0912
    parsed = _parse_clickhouse_type(type_str)
    scalar = _map_scalar(parsed.base, bigint_mode)
    if scalar is not None:
        return _Resolved(py_type=scalar, nullable=False)
    if parsed.base == "Nullable":
        if not parsed.args:
            return None
        inner = _resolve_inner(parsed.args[0], bigint_mode)
        if inner is None:
            return None
        return _Resolved(py_type=f"{inner.py_type} | None", nullable=True)
    if parsed.base == "LowCardinality":
        if not parsed.args:
            return None
        return _resolve_inner(parsed.args[0], bigint_mode)
    if parsed.base == "Array":
        if not parsed.args:
            return None
        inner = _resolve_inner(parsed.args[0], bigint_mode)
        if inner is None:
            return None
        return _Resolved(py_type=f"list[{inner.py_type}]", nullable=False)
    if parsed.base == "Map":
        if len(parsed.args) < 2:  # noqa: PLR2004
            return None
        key = _resolve_inner(parsed.args[0], bigint_mode)
        value = _resolve_inner(parsed.args[1], bigint_mode)
        if key is None or value is None:
            return None
        return _Resolved(py_type=f"dict[{key.py_type}, {value.py_type}]", nullable=False)
    if parsed.base == "Tuple":
        if not parsed.args:
            return None
        elements = [_resolve_inner(arg, bigint_mode) for arg in parsed.args]
        if any(e is None for e in elements):
            return None
        valid = [e.py_type for e in elements if e is not None]
        return _Resolved(py_type=f"tuple[{', '.join(valid)}]", nullable=False)
    if parsed.base == "SimpleAggregateFunction":
        if len(parsed.args) < 2:  # noqa: PLR2004
            return None
        return _resolve_inner(parsed.args[-1], bigint_mode)
    if parsed.base == "JSON":
        return _Resolved(py_type="dict[str, Any]", nullable=False)
    return None


def _resolve_column_type(type_str: str, bigint_mode: BigIntMode) -> _Resolved | None:
    parsed = _parse_clickhouse_type(type_str)
    if parsed.base == "LowCardinality" and parsed.args:
        return _resolve_column_type(parsed.args[0], bigint_mode)
    if parsed.base == "Nullable" and parsed.args:
        inner = _resolve_column_type(parsed.args[0], bigint_mode)
        if inner is None:
            return None
        return _Resolved(py_type=inner.py_type, nullable=True)
    return _resolve_inner(type_str, bigint_mode)


def map_column_type(
    *,
    column: ColumnDefinition,
    path: str,
    options: CodegenOptions,
) -> MapColumnTypeResult:
    """Map a single column to a Python type expression."""
    resolved = _resolve_column_type(column.type, options.bigint_mode)
    column_nullable = column.nullable is True
    if resolved is None:
        if options.fail_on_unsupported_type:
            raise UnsupportedTypeError(path, column.type)
        py_type = "Any | None" if column_nullable else "Any"
        return MapColumnTypeResult(
            py_type=py_type,
            nullable=column_nullable,
            finding=CodegenFinding(
                code="codegen_unsupported_type",
                message=(
                    f'Unsupported type "{column.type}" at {path}; emitted Any.'
                ),
                severity="warn",
                path=path,
            ),
        )
    nullable = column_nullable or resolved.nullable
    if nullable and not resolved.py_type.endswith("| None"):
        py_type = f"{resolved.py_type} | None"
    else:
        py_type = resolved.py_type
    return MapColumnTypeResult(py_type=py_type, nullable=nullable)


# ---------- model rendering ----------


def _render_header(tool_version: str) -> list[str]:
    return [
        "# This file is auto-generated by chkit codegen — do not edit manually.",
        f"# chkit-codegen-version: {tool_version}",
    ]


def _render_fields_model(
    fields: list[ColumnDefinition],
    class_name: str,
    path_prefix: str,
    options: CodegenOptions,
) -> tuple[list[str], list[CodegenFinding], set[str]]:
    """Render the lines for a list of columns → Pydantic model."""
    findings: list[CodegenFinding] = []
    imports_needed: set[str] = set()
    lines: list[str] = [f"class {class_name}(BaseModel):"]
    if not fields:
        lines.append("    pass")
        lines.append("")
        return lines, findings, imports_needed

    for column in fields:
        path = f"{path_prefix}.{column.name}"
        mapped = map_column_type(column=column, path=path, options=options)
        if mapped.finding is not None:
            findings.append(mapped.finding)
            imports_needed.add("Any")
        if "Any" in mapped.py_type:
            imports_needed.add("Any")
        attr = render_attribute_name(column.name)
        if attr == column.name:
            lines.append(f"    {attr}: {mapped.py_type}")
        else:
            imports_needed.add("Field")
            # repr() handles embedded quotes/backslashes safely.
            lines.append(
                f"    {attr}: {mapped.py_type} = Field(..., alias={column.name!r})"
            )
    lines.append("")
    lines.append("    model_config = ConfigDict(populate_by_name=True)")
    lines.append("")
    return lines, findings, imports_needed


def _render_table_model(
    table: TableDefinition,
    class_name: str,
    options: CodegenOptions,
) -> tuple[list[str], list[CodegenFinding], set[str]]:
    """Render the lines for a single table → Pydantic model."""
    return _render_fields_model(
        list(table.columns), class_name, f"{table.database}.{table.name}", options
    )


def _render_dictionary_model(
    definition: DictionaryDefinition,
    class_name: str,
    options: CodegenOptions,
) -> tuple[list[str], list[CodegenFinding], set[str]]:
    """Render the lines for a single dictionary → Pydantic model."""
    fields = [
        ColumnDefinition(name=attribute.name, type=attribute.type)
        for attribute in definition.attributes
    ]
    return _render_fields_model(
        fields, class_name, f"{definition.database}.{definition.name}", options
    )


def _render_view_model(
    definition: ViewDefinition | MaterializedViewDefinition,
    class_name: str,
) -> tuple[list[str], list[CodegenFinding], set[str]]:
    kind = "view" if definition.kind == "view" else "materialized_view"
    comment = (
        f"# {kind} {definition.database}.{definition.name} is emitted "
        "as a free-form dict row in v1."
    )
    return (
        [
            comment,
            f"{class_name}: TypeAlias = dict[str, Any]",
            "",
        ],
        [],
        {"Any", "TypeAlias"},
    )


def generate_type_artifacts(
    *,
    definitions: list[SchemaDefinition],
    options: PluginConfig | CodegenOptions | dict[str, object] | None = None,
    tool_version: str = "0.1.0",
) -> GenerateTypeArtifactsOutput:
    """Generate the Pydantic-model module content from a list of definitions."""
    normalized = normalize_codegen_options(options)

    canonical = canonicalize_definitions(definitions)
    view_kinds = {"view", "materialized_view"}
    filtered: list[
        TableDefinition
        | ViewDefinition
        | MaterializedViewDefinition
        | DictionaryDefinition
    ] = [
        definition
        for definition in canonical
        if definition.kind in {"table", "dictionary"}
        or (normalized.include_views and definition.kind in view_kinds)
    ]
    filtered.sort(key=lambda d: (d.database, d.name))

    resolved: list[ResolvedTableName] = resolve_table_names(
        filtered, normalized.table_name_style
    )

    findings: list[CodegenFinding] = []
    body_lines: list[str] = []
    imports_needed: set[str] = set()

    for entry in resolved:
        definition = entry.definition
        if isinstance(definition, TableDefinition):
            lines, table_findings, needed = _render_table_model(
                definition, entry.class_name, normalized
            )
        elif isinstance(definition, DictionaryDefinition):
            lines, table_findings, needed = _render_dictionary_model(
                definition, entry.class_name, normalized
            )
        else:
            lines, table_findings, needed = _render_view_model(
                definition, entry.class_name
            )
        findings.extend(table_findings)
        imports_needed.update(needed)
        body_lines.extend(lines)

    typing_imports = sorted({sym for sym in imports_needed if sym in {"Any", "TypeAlias"}})
    pydantic_imports: list[str] = ["BaseModel", "ConfigDict"]
    if "Field" in imports_needed:
        pydantic_imports.append("Field")

    header = _render_header(tool_version)
    output_lines: list[str] = [*header, "", "from __future__ import annotations", ""]
    if typing_imports:
        output_lines.append(f"from typing import {', '.join(typing_imports)}")
    output_lines.append(
        f"from pydantic import {', '.join(pydantic_imports)}"
    )
    output_lines.append("")
    output_lines.extend(body_lines)

    content = "\n".join(output_lines).rstrip() + "\n"

    return GenerateTypeArtifactsOutput(
        content=content,
        out_file=normalized.out_file,
        declaration_count=len(resolved),
        findings=findings,
    )


__all__ = [
    "GenerateTypeArtifactsOutput",
    "MapColumnTypeResult",
    "generate_type_artifacts",
    "map_column_type",
]
