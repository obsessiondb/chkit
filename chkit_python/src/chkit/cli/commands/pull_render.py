"""Render a Python schema module from a list of SchemaDefinition objects.

Python equivalent of ``packages/plugin-pull/src/render-schema.ts``.

The TS version emits a ``.ts`` file using ``table()/view()/materializedView()``
from ``@chkit/core``. This Python version emits a ``.py`` file using the
same-named factories from ``chkit``:

    from chkit import ColumnDefinition, schema, table

    db_events = table(
        database="db",
        name="events",
        engine="MergeTree",
        columns=[
            ColumnDefinition(name="id", type="UInt64"),
        ],
        primary_key=["id"],
        order_by=["id"],
    )

    definitions = schema(db_events)

The output is canonicalized first (deterministic ordering), and the variable
names are sanitized + collision-deduped so two tables with the same stem
across databases coexist.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence

from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import (
    ColumnCodec,
    ColumnCodecSpec,
    ColumnDefinition,
    DictionaryAttribute,
    DictionaryDefinition,
    MaterializedViewDefinition,
    MaterializedViewRefresh,
    ProjectionDefinition,
    RawColumnCodec,
    SchemaDefinition,
    SkipIndexDefinition,
    TableDefinition,
    ViewDefinition,
)
from chkit.core.projection import is_index_projection

_MIN_QUOTED_LEN = 2

_IDENT_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
_NON_IDENT_RE = re.compile(r"[^a-zA-Z0-9_]")
_MULTI_UNDERSCORE_RE = re.compile(r"_+")
_LEADING_TRAILING_UNDERSCORE_RE = re.compile(r"^_+|_+$")


def render_schema_file(  # noqa: PLR0912, PLR0915
    definitions: Sequence[SchemaDefinition],
) -> str:
    """Render canonical Python schema source from a list of definitions."""
    canonical = canonicalize_definitions(list(definitions))
    declaration_counts: dict[str, int] = {}

    has_table = any(isinstance(d, TableDefinition) for d in canonical)
    has_view = any(isinstance(d, ViewDefinition) for d in canonical)
    has_materialized_view = any(
        isinstance(d, MaterializedViewDefinition) for d in canonical
    )
    has_table_ref = has_materialized_view or any(
        isinstance(d, MaterializedViewDefinition)
        and d.refresh is not None
        and d.refresh.depends_on
        for d in canonical
    )
    has_mv_refresh = any(
        isinstance(d, MaterializedViewDefinition) and d.refresh is not None
        for d in canonical
    )
    has_column_def = has_table
    has_raw_codec = any(
        isinstance(d, TableDefinition)
        and any(c.codec is not None and _codec_contains_raw(c.codec) for c in d.columns)
        for d in canonical
    )

    index_classes: set[str] = set()
    for d in canonical:
        if not isinstance(d, TableDefinition) or not d.indexes:
            continue
        for idx in d.indexes:
            index_classes.add(
                {
                    "minmax": "SkipIndexMinmax",
                    "set": "SkipIndexSet",
                    "bloom_filter": "SkipIndexBloomFilter",
                    "tokenbf_v1": "SkipIndexTokenBF",
                    "ngrambf_v1": "SkipIndexNgramBF",
                }[idx.type]
            )

    has_projection = any(
        isinstance(d, TableDefinition) and d.projections for d in canonical
    )
    has_dictionary = any(isinstance(d, DictionaryDefinition) for d in canonical)
    has_dictionary_attribute = has_dictionary
    has_dictionary_range = any(
        isinstance(d, DictionaryDefinition) and d.range is not None for d in canonical
    )

    imports: list[str] = ["schema"]
    if has_table:
        imports.append("table")
    if has_view:
        imports.append("view")
    if has_materialized_view:
        imports.append("materialized_view")
    if has_dictionary:
        imports.append("dictionary")
    if has_dictionary_attribute:
        imports.append("DictionaryAttribute")
    if has_dictionary_range:
        imports.append("DictionaryRange")
    if has_mv_refresh:
        imports.append("MaterializedViewRefresh")
    if has_table_ref:
        imports.append("TableRef")
    if has_column_def:
        imports.append("ColumnDefinition")
    if has_projection:
        imports.append("ProjectionDefinition")
    if has_raw_codec:
        imports.append("codec_raw")
    imports.extend(index_classes)

    lines: list[str] = [
        '"""Schema pulled from live ClickHouse metadata via `chkit pull`."""',
        "",
        f"from chkit import {', '.join(sorted(set(imports)))}",
        "",
    ]

    references: list[str] = []
    for definition in canonical:
        variable_name = _resolve_variable_name(
            definition.database, definition.name, declaration_counts
        )
        references.append(variable_name)

        if isinstance(definition, TableDefinition):
            lines.extend(_render_table(variable_name, definition))
        elif isinstance(definition, ViewDefinition):
            lines.extend(_render_view(variable_name, definition))
        elif isinstance(definition, DictionaryDefinition):
            lines.extend(_render_dictionary(variable_name, definition))
        elif isinstance(definition, MaterializedViewDefinition):
            lines.extend(_render_materialized_view(variable_name, definition))
        lines.append("")

    if references:
        lines.append(f"definitions = schema({', '.join(references)})")
    else:
        lines.append("definitions = schema()")

    return "\n".join(lines) + "\n"


# ---------- table ----------


def _render_table(variable_name: str, definition: TableDefinition) -> list[str]:
    lines: list[str] = [
        f"{variable_name} = table(",
        f"    database={_render_string(definition.database)},",
        f"    name={_render_string(definition.name)},",
        f"    engine={_render_string(definition.engine)},",
        "    columns=[",
    ]
    lines.extend(f"        {_render_column(column)}," for column in definition.columns)
    lines.append("    ],")
    lines.append(f"    primary_key={_render_string_list(definition.primary_key)},")
    lines.append(f"    order_by={_render_string_list(definition.order_by)},")
    if definition.unique_key:
        lines.append(f"    unique_key={_render_string_list(definition.unique_key)},")
    if definition.partition_by:
        lines.append(f"    partition_by={_render_string(definition.partition_by)},")
    if definition.ttl:
        lines.append(f"    ttl={_render_string(definition.ttl)},")
    if definition.settings:
        lines.append("    settings={")
        for key in sorted(definition.settings):
            value = definition.settings[key]
            lines.append(f"        {_render_string(key)}: {_render_literal(value)},")
        lines.append("    },")
    if definition.indexes:
        lines.append("    indexes=[")
        lines.extend(f"        {_render_index(idx)}," for idx in definition.indexes)
        lines.append("    ],")
    if definition.projections:
        lines.append("    projections=[")
        lines.extend(
            f"        {_render_projection(p)}," for p in definition.projections
        )
        lines.append("    ],")
    lines.append(")")
    return lines


def _render_column(column: ColumnDefinition) -> str:
    parts: list[str] = [
        f"name={_render_string(column.name)}",
        f"type={_render_string(column.type)}",
    ]
    if column.nullable:
        parts.append("nullable=True")
    if column.default is not None:
        parts.append(f"default={_render_literal(column.default)}")
    if column.comment:
        parts.append(f"comment={_render_string(column.comment)}")
    if column.codec is not None:
        parts.append(f"codec={_render_codec(column.codec)}")
    return f"ColumnDefinition({', '.join(parts)})"


def _render_index(index: SkipIndexDefinition) -> str:
    parts: list[str] = [
        f"name={_render_string(index.name)}",
        f"expression={_render_string(index.expression)}",
        f"type={_render_string(index.type)}",
    ]
    if index.type == "set":
        parts.append(f"max_rows={index.max_rows}")
    elif index.type == "bloom_filter":
        if index.false_positive_rate is not None:
            parts.append(f"false_positive_rate={index.false_positive_rate}")
    elif index.type == "tokenbf_v1":
        parts.append(f"size_bytes={index.size_bytes}")
        parts.append(f"hash_functions={index.hash_functions}")
        parts.append(f"random_seed={index.random_seed}")
    elif index.type == "ngrambf_v1":
        parts.append(f"ngram_size={index.ngram_size}")
        parts.append(f"size_bytes={index.size_bytes}")
        parts.append(f"hash_functions={index.hash_functions}")
        parts.append(f"random_seed={index.random_seed}")
    parts.append(f"granularity={index.granularity}")
    type_class = {
        "minmax": "SkipIndexMinmax",
        "set": "SkipIndexSet",
        "bloom_filter": "SkipIndexBloomFilter",
        "tokenbf_v1": "SkipIndexTokenBF",
        "ngrambf_v1": "SkipIndexNgramBF",
    }[index.type]
    return f"{type_class}({', '.join(parts)})"


def _render_projection(projection: ProjectionDefinition) -> str:
    if is_index_projection(projection):
        fields = (
            f"index={_render_string(projection.index or '')}, "
            f"type={_render_string(projection.type or '')}"
        )
    else:
        fields = f"query={_render_string(projection.query or '')}"
    return f"ProjectionDefinition(name={_render_string(projection.name)}, {fields})"


# ---------- dictionary ----------


_HIDDEN_SECRET_NOTE = (
    "# NOTE: password redacted by ClickHouse — replace '[HIDDEN]' with your "
    'credential (e.g. os.environ["X"]).'
)


def _render_dictionary(
    variable_name: str, definition: DictionaryDefinition
) -> list[str]:
    lines: list[str] = []
    if "[HIDDEN]" in definition.source:
        lines.append(_HIDDEN_SECRET_NOTE)
    lines.extend(
        [
            f"{variable_name} = dictionary(",
            f"    database={_render_string(definition.database)},",
            f"    name={_render_string(definition.name)},",
            "    attributes=[",
        ]
    )
    lines.extend(
        f"        {_render_dictionary_attribute(a)}," for a in definition.attributes
    )
    lines.append("    ],")
    lines.append(f"    primary_key={_render_string_list(definition.primary_key)},")
    lines.append(f"    source={_render_string(definition.source)},")
    lines.append(f"    layout={_render_string(definition.layout)},")
    lines.append(f"    lifetime={_render_string(definition.lifetime)},")
    if definition.range is not None:
        lines.append(
            f"    range=DictionaryRange(min={_render_string(definition.range.min)}, "
            f"max={_render_string(definition.range.max)}),"
        )
    if definition.settings:
        lines.append("    settings={")
        for key in sorted(definition.settings):
            value = definition.settings[key]
            lines.append(f"        {_render_string(key)}: {_render_literal(value)},")
        lines.append("    },")
    if definition.comment:
        lines.append(f"    comment={_render_string(definition.comment)},")
    lines.append(")")
    return lines


def _render_dictionary_attribute(attribute: DictionaryAttribute) -> str:
    parts: list[str] = [
        f"name={_render_string(attribute.name)}",
        f"type={_render_string(attribute.type)}",
    ]
    if attribute.expression is not None:
        parts.append(f"expression={_render_string(attribute.expression)}")
    elif attribute.default is not None:
        parts.append(f"default={_render_literal(attribute.default)}")
    if attribute.hierarchical:
        parts.append("hierarchical=True")
    if attribute.bidirectional:
        parts.append("bidirectional=True")
    if attribute.injective:
        parts.append("injective=True")
    if attribute.is_object_id:
        parts.append("is_object_id=True")
    return f"DictionaryAttribute({', '.join(parts)})"


# ---------- view ----------


def _render_view(variable_name: str, definition: ViewDefinition) -> list[str]:
    return [
        f"{variable_name} = view(",
        f"    database={_render_string(definition.database)},",
        f"    name={_render_string(definition.name)},",
        f"    as_={_render_string(definition.as_)},",
        ")",
    ]


# ---------- materialized view ----------


def _render_materialized_view(
    variable_name: str, definition: MaterializedViewDefinition
) -> list[str]:
    lines: list[str] = [
        f"{variable_name} = materialized_view(",
        f"    database={_render_string(definition.database)},",
        f"    name={_render_string(definition.name)},",
        (
            f"    to=TableRef(database={_render_string(definition.to.database)}, "
            f"name={_render_string(definition.to.name)}),"
        ),
    ]
    if definition.refresh is not None:
        lines.extend(_render_refresh(definition.refresh))
    lines.append(f"    as_={_render_string(definition.as_)},")
    lines.append(")")
    return lines


def _render_refresh(refresh: MaterializedViewRefresh) -> list[str]:
    lines = ["    refresh=MaterializedViewRefresh("]
    if refresh.every:
        lines.append(f"        every={_render_string(refresh.every)},")
    if refresh.after:
        lines.append(f"        after={_render_string(refresh.after)},")
    if refresh.offset:
        lines.append(f"        offset={_render_string(refresh.offset)},")
    if refresh.randomize:
        lines.append(f"        randomize={_render_string(refresh.randomize)},")
    if refresh.depends_on:
        lines.append("        depends_on=[")
        lines.extend(
            f"            TableRef(database={_render_string(dep.database)}, "
            f"name={_render_string(dep.name)}),"
            for dep in refresh.depends_on
        )
        lines.append("        ],")
    if refresh.settings:
        lines.append("        settings={")
        for key in sorted(refresh.settings):
            value = refresh.settings[key]
            lines.append(f"            {_render_string(key)}: {_render_literal(value)},")
        lines.append("        },")
    if refresh.append:
        lines.append("        append=True,")
    if refresh.empty:
        lines.append("        empty=True,")
    lines.append("    ),")
    return lines


# ---------- helpers ----------


def _resolve_variable_name(
    database: str, name: str, counts: dict[str, int]
) -> str:
    base = _sanitize_identifier(f"{database}_{name}")
    current = counts.get(base, 0)
    next_ = current + 1
    counts[base] = next_
    return base if next_ == 1 else f"{base}_{next_}"


def _sanitize_identifier(value: str) -> str:
    sanitized = _LEADING_TRAILING_UNDERSCORE_RE.sub(
        "", _MULTI_UNDERSCORE_RE.sub("_", _NON_IDENT_RE.sub("_", value))
    )
    if not sanitized:
        return "table_ref"
    if sanitized[0].isdigit():
        return f"table_{sanitized}"
    return sanitized


def _render_string(value: str) -> str:
    return json.dumps(value)


def _render_string_list(values: Sequence[str]) -> str:
    return f"[{', '.join(_render_string(v) for v in values)}]"


def _render_literal(value: object) -> str:
    if isinstance(value, str):
        return _render_string(value)
    if isinstance(value, bool):
        return "True" if value else "False"
    return repr(value)


def _codec_contains_raw(spec: ColumnCodecSpec) -> bool:
    steps = spec if isinstance(spec, list) else [spec]
    return any(isinstance(s, RawColumnCodec) for s in steps)


def _render_codec_step(step: ColumnCodec) -> str:
    if isinstance(step, RawColumnCodec):
        return f"codec_raw({_render_string(step.expression)})"
    parts = [f'"kind": {_render_string(step.kind)}']
    if step.kind in {"ZSTD", "LZ4HC"}:
        level = getattr(step, "level", None)
        if level is not None:
            parts.append(f'"level": {level}')
    elif step.kind in {"Delta", "DoubleDelta", "Gorilla"}:
        size = getattr(step, "size", None)
        if size is not None:
            parts.append(f'"size": {size}')
    elif step.kind == "FPC":
        parts.append(f'"level": {step.level}')
        parts.append(f'"floatSize": {step.float_size}')
    return "{" + ", ".join(parts) + "}"


def _render_codec(spec: ColumnCodecSpec) -> str:
    steps = spec if isinstance(spec, list) else [spec]
    if len(steps) == 1:
        return _render_codec_step(steps[0])
    return "[" + ", ".join(_render_codec_step(s) for s in steps) + "]"
