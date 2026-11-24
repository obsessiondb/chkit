"""Chunk-execution SQL builder + shared SQL scanner.

1:1 port of ``chunking/sql.ts`` (post-refactor ``9ad23f9``): the
quote/paren-skipping scan lives in one primitive (:func:`_scan_sql_tokens`)
shared by top-level keyword detection and top-level delimiter splitting.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping

from chkit.core.jsnum import js_number_to_string
from chkit_plugin_backfill.chunking.types import (
    Chunk,
    ChunkRange,
    EstimateFilter,
    PlannerContext,
    RowProbeStrategy,
    SortKey,
    SortKeyCategory,
    TableProfile,
)
from chkit_plugin_backfill.chunking.utils.binary_string import latin1_bytes
from chkit_plugin_backfill.errors import BackfillConfigError

# Top-level clause keywords, in the order they may legally follow a
# projection. `inject_where_condition` uses this both to detect an existing
# `WHERE` and to find the first trailing clause a new condition must be
# inserted before.
_TRAILING_CLAUSE_KEYWORDS = (
    "WHERE",
    "GROUP BY",
    "HAVING",
    "ORDER BY",
    "QUALIFY",
    "LIMIT",
    "SETTINGS",
)

# Written first in every chunk INSERT: a synchronous insert, and ``SELECT *``
# expanded to the insertable columns regardless of the user's profile (see
# ``_build_settings_clause``). ``insertSettings`` cannot change them.
_FIXED_INSERT_SETTINGS: dict[str, str] = {
    "async_insert": "0",
    "asterisk_include_materialized_columns": "0",
    "asterisk_include_alias_columns": "0",
}

# Written by a cutover copy after ``_FIXED_INSERT_SETTINGS`` (see
# ``_build_cutover_chunk_sql``).
_CUTOVER_INSERT_SETTINGS: dict[str, str] = {
    "insert_deduplicate": "0",
    "select_sequential_consistency": "1",
}

# Each chunk's own dedup token, which chkit writes when the plan requires one.
_TOKEN_SETTING = "insert_deduplication_token"

_JS_WS_CLASS = (
    "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a"
    "\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
)
_JS_WS_RE = re.compile(f"[{_JS_WS_CLASS}]")


def _is_js_space(char: str) -> bool:
    return _JS_WS_RE.match(char) is not None


def _js_trim_end(value: str) -> str:
    end = len(value)
    while end > 0 and _is_js_space(value[end - 1]):
        end -= 1
    return value[:end]


def _js_trim(value: str) -> str:
    start = 0
    while start < len(value) and _is_js_space(value[start]):
        start += 1
    return _js_trim_end(value[start:])


# ── Chunk execution SQL ──────────────────────────────────────────────────────


#: Settings every chunk INSERT runs with, in its own SETTINGS so they win over
#: profile defaults (#765, TS ``PINNED_INSERT_SETTINGS``). The INSERT never runs
#: as secondary queries on other replicas or shards (parallel replicas, a
#: Distributed INSERT SELECT), whose writes its own written_rows may not count
#: and whose query_log rows can flush late, and it is always logged, its start
#: included: a resume proves a failure from that log alone.
#:
#: An INSERT into a Distributed table (the target, or a materialized view's)
#: also returns only once its rows reached the shards (#821): by default it
#: returns once they are queued on the initiator, and the chunk would be done
#: before they are delivered. A materialized view's write that fails fails the
#: INSERT: with materialized_views_ignore_errors = 1 a shard that cannot be
#: reached would drop the view's rows and the chunk would still be done. These
#: two are pinned for delivery, not for proof (``DELIVERY_PINS``): writing to a
#: remote shard runs a secondary query there, so the failure of such a chunk is
#: never proven, as for any Distributed target (``unprovable_target_failures``).
#: They are defaults that ``insertSettings`` can override.
PINNED_INSERT_SETTINGS: dict[str, str] = {
    "allow_experimental_parallel_reading_from_replicas": "0",
    "parallel_distributed_insert_select": "0",
    "distributed_foreground_insert": "1",
    "materialized_views_ignore_errors": "0",
    "log_queries": "1",
    "log_queries_min_type": "'QUERY_START'",
    "log_queries_min_query_duration_ms": "0",
    "log_queries_probability": "1",
}

PINNED_INSERT_SETTINGS_SQL = ", ".join(
    f"{name}={value}" for name, value in PINNED_INSERT_SETTINGS.items()
)

#: The pinned settings ``insertSettings`` may override, each with the guarantee
#: an override turns off (TS ``DELIVERY_PINS``). The others are proof pins:
#: with another value a failure could not be proven, and a replay could write
#: a chunk's rows twice.
DELIVERY_PINS: dict[str, str] = {
    "distributed_foreground_insert": (
        "a chunk can be recorded done before its rows reach a Distributed table's shards"
    ),
    "materialized_views_ignore_errors": (
        "a materialized view's failed write is dropped and the chunk is still recorded done"
    ),
}

_PROOF_PINS_SQL = ", ".join(
    f"{name}={value}"
    for name, value in PINNED_INSERT_SETTINGS.items()
    if name not in DELIVERY_PINS
)


#: Other names of the pinned settings (``system.settings.alias_for``), for a
#: server that does not list them: ``enable_parallel_replicas`` is an alias of
#: ``allow_experimental_parallel_reading_from_replicas`` from 24.10 on, and
#: ``insert_distributed_sync`` one of ``distributed_foreground_insert``.
PINNED_SETTING_ALIASES: dict[str, str] = {
    "enable_parallel_replicas": "allow_experimental_parallel_reading_from_replicas",
    "insert_distributed_sync": "distributed_foreground_insert",
}


# A setting name; any other key could smuggle text into the SETTINGS clause.
_SETTING_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _fixed_settings(*, cutover: bool) -> dict[str, str]:
    """The settings chkit writes itself on a chunk INSERT before the user's,
    besides the dedup token (``_TOKEN_SETTING``)."""
    return {**_FIXED_INSERT_SETTINGS, **(_CUTOVER_INSERT_SETTINGS if cutover else {})}


def _compulsory_name(
    key: str, aliases: Mapping[str, str] | None, *, cutover: bool
) -> str | None:
    """The pinned or fixed setting ``key`` names, itself or through an alias."""
    names = {*PINNED_INSERT_SETTINGS, *_fixed_settings(cutover=cutover), _TOKEN_SETTING}
    name = key if key in names else {**PINNED_SETTING_ALIASES, **(aliases or {})}.get(key)
    return name if name in names else None


# A decimal number as ClickHouse reads a numeric setting's value ("1.0", "+0", "1e0").
_DECIMAL = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")


def _normal_text(text: str) -> str:
    """A setting value as compared with chkit's (TS ``normalText``): unquoted,
    lowercased, booleans as 1/0, and a number in its shortest form, so
    ``'1.0'``, ``1`` and ``true`` are the same value."""
    bare = text.strip("'").lower()
    bare = {"true": "1", "false": "0"}.get(bare, bare)
    return js_number_to_string(float(bare)) if _DECIMAL.fullmatch(bare) else bare


def _normal_value(value: str | int | float | bool) -> str:
    return _normal_text(_render_insert_setting_value(value))


def _same_value(value: str | int | float | bool, pinned: str) -> bool:
    return _normal_value(value) == _normal_text(pinned)


def _kept_value(name: str, value: str | int | float | bool, *, cutover: bool) -> bool:
    """Whether ``value`` of the compulsory setting ``name`` is what chkit
    writes. The dedup token is per chunk, so no value is."""
    written = {**PINNED_INSERT_SETTINGS, **_fixed_settings(cutover=cutover)}.get(name)
    return written is not None and _same_value(value, written)


def compulsory_setting_names() -> list[str]:
    """Every setting chkit writes on a chunk INSERT in any mode, for reading
    the server's aliases of them (``read_pinned_setting_aliases``)."""
    return [
        *PINNED_INSERT_SETTINGS,
        *_FIXED_INSERT_SETTINGS,
        *_CUTOVER_INSERT_SETTINGS,
        _TOKEN_SETTING,
    ]


def assert_insert_settings_keep_pinned(
    insert_settings: Mapping[str, str | int | float | bool] | None,
    aliases: Mapping[str, str] | None = None,
    *,
    cutover: bool = False,
) -> None:
    """Refuse ``insertSettings`` that set a setting chkit writes itself, or an
    alias of one, to another value: a proof pin (``PINNED_INSERT_SETTINGS`` but
    not ``DELIVERY_PINS``), which keeps the chunk INSERT off secondary queries
    and logged, or a fixed one (``_FIXED_INSERT_SETTINGS``, a cutover copy's
    ``_CUTOVER_INSERT_SETTINGS``, the dedup token). One with chkit's value is
    dropped (``effective_insert_settings``). A delivery pin may be overridden,
    but not set twice (itself and an alias) to different values. ``aliases``
    adds the server's own (``system.settings.alias_for``) to
    ``PINNED_SETTING_ALIASES``."""
    invalid = [key for key in insert_settings or {} if not _SETTING_NAME.fullmatch(key)]
    if invalid:
        names = ", ".join(f"'{key}'" for key in invalid)
        msg = (
            f"insertSettings has a key that is not a setting name: {names}. A setting name "
            "is letters, digits and underscores, not starting with a digit."
        )
        raise BackfillConfigError(msg)
    proof_conflicts: list[str] = []
    fixed_conflicts: list[str] = []
    seen: dict[str, list[tuple[str, str | int | float | bool]]] = {}
    for key, value in (insert_settings or {}).items():
        name = _compulsory_name(key, aliases, cutover=cutover)
        if name is None:
            continue
        seen.setdefault(name, []).append((key, value))
        if name in DELIVERY_PINS or _kept_value(name, value, cutover=cutover):
            continue
        rendered = f"{key}={_render_insert_setting_value(value)}"
        named = rendered if name == key else f"{rendered} (an alias of {name})"
        (proof_conflicts if name in PINNED_INSERT_SETTINGS else fixed_conflicts).append(named)
    if proof_conflicts:
        msg = (
            f"insertSettings sets {', '.join(proof_conflicts)}, which every backfill chunk "
            f"INSERT pins ({_PROOF_PINS_SQL}): with another value, its failure cannot be "
            "proven from system.query_log, and a replay could write its rows twice. "
            "Remove them from insertSettings."
        )
        raise BackfillConfigError(msg)
    if fixed_conflicts:
        fixed = ", ".join(
            f"{name}={value}" for name, value in _fixed_settings(cutover=cutover).items()
        )
        msg = (
            f"insertSettings sets {', '.join(fixed_conflicts)}, which chkit sets itself on "
            f"every backfill chunk INSERT ({fixed}, {_TOKEN_SETTING} per chunk): another "
            "value could drop, duplicate or delay a chunk's rows. Remove them from "
            "insertSettings."
        )
        raise BackfillConfigError(msg)
    for name, entries in seen.items():
        if len({_normal_value(value) for _key, value in entries}) > 1:
            both = ", ".join(
                f"{key}={_render_insert_setting_value(value)}" for key, value in entries
            )
            msg = (
                f"insertSettings sets {name} more than once, with different values ({both}). "
                "Keep one of them."
            )
            raise BackfillConfigError(msg)


def effective_insert_settings(
    insert_settings: Mapping[str, str | int | float | bool] | None,
    aliases: Mapping[str, str] | None = None,
    *,
    cutover: bool = False,
) -> dict[str, str | int | float | bool]:
    """``insert_settings`` without the settings chkit writes itself and their
    aliases, except an override of a delivery pin, kept under the pinned
    name: such a setting appears once in the INSERT's SETTINGS, in its place."""
    effective: dict[str, str | int | float | bool] = {}
    for key, value in (insert_settings or {}).items():
        name = _compulsory_name(key, aliases, cutover=cutover)
        if name is None:
            effective[key] = value
        elif name in DELIVERY_PINS and not _same_value(value, PINNED_INSERT_SETTINGS[name]):
            effective[name] = value
    return effective


def chunk_insert_settings_sql(
    insert_settings: Mapping[str, str | int | float | bool] | None = None,
    *,
    token: str = "",
    cutover: bool = False,
) -> str:
    """The settings of a chunk INSERT (TS ``chunkInsertSettingsSql``), in one
    list: the user's own first, delivery overrides included, then everything
    chkit requires, so that a later setting wins over whatever the user's set
    (a settings profile included): the fixed settings, a cutover's, the dedup
    token, and the pins, without the delivery ones the user overrides."""
    assert_insert_settings_keep_pinned(insert_settings, cutover=cutover)
    effective = effective_insert_settings(insert_settings, cutover=cutover)
    parts = [f"{key}={_render_insert_setting_value(value)}" for key, value in effective.items()]
    parts.extend(f"{name}={value}" for name, value in _fixed_settings(cutover=cutover).items())
    if token:
        parts.append(f"{_TOKEN_SETTING}='{token}'")
    parts.extend(
        f"{name}={value}"
        for name, value in PINNED_INSERT_SETTINGS.items()
        if not (name in DELIVERY_PINS and name in effective)
    )
    return ", ".join(parts)


def delivery_override_warning(
    insert_settings: Mapping[str, str | int | float | bool] | None,
) -> str | None:
    """The one warning line a run or submit prints when ``insert_settings``
    overrides a delivery pin, or None."""
    overridden = [
        f"{name}={_render_insert_setting_value(value)} ({DELIVERY_PINS[name]})"
        for name, value in effective_insert_settings(insert_settings).items()
        if name in DELIVERY_PINS
    ]
    if not overridden:
        return None
    return (
        "Warning: insertSettings overrides what every backfill chunk INSERT sets by "
        f"default: {'; '.join(overridden)}."
    )


def build_chunk_execution_sql(
    *,
    plan_id: str,
    chunk: Chunk,
    target: str,
    table: TableProfile,
    source_target: str | None = None,
    mv_replay_queries: list[str] | None = None,
    target_columns: list[str] | None = None,
    idempotency_token: str | None = None,
    insert_settings: Mapping[str, str | int | float | bool] | None = None,
    cutover_key: list[str] | None = None,
) -> str:
    resolved_source = source_target if source_target is not None else target
    token = idempotency_token if idempotency_token is not None else ""
    header = f"/* chkit backfill plan={plan_id} chunk={chunk.id} token={token} */"
    settings = _build_settings_clause(token, insert_settings)
    chunk_conditions = _build_chunk_conditions(chunk, table.sort_keys)

    if cutover_key and target_columns:
        return _build_cutover_chunk_sql(
            chunk=chunk,
            target=target,
            table=table,
            source_target=resolved_source,
            target_columns=target_columns,
            cutover_key=cutover_key,
            header=header,
            chunk_conditions=chunk_conditions,
            insert_settings=insert_settings,
        )

    if mv_replay_queries:
        # Each MV feeding the target becomes a filtered SELECT; UNION ALL replays
        # them in one INSERT so a single query_id and dedup token cover the chunk.
        # With the plan's column list, both sides name the columns and each
        # view's output is read by name, as ClickHouse does for a view's TO table.
        columns = (
            ", ".join(_quote_identifier(name) for name in target_columns)
            if target_columns
            else None
        )
        selects: list[str] = []
        for query in mv_replay_queries:
            filtered = _inject_partition_filter(query, chunk.partition_id)
            for condition in chunk_conditions:
                filtered = _inject_where_condition(filtered, condition)
            selects.append(f"SELECT {columns}\nFROM (\n{filtered}\n)" if columns else filtered)
        insert = f"INSERT INTO {target} ({columns})" if columns else f"INSERT INTO {target}"
        return "\n".join([header, insert, "\nUNION ALL\n".join(selects), settings])

    lines = [
        header,
        f"INSERT INTO {target}",
        "SELECT *",
        f"FROM {resolved_source}",
        f"WHERE _partition_id = {_quote_sql_string(chunk.partition_id)}",
    ]

    lines.extend(f"  AND {condition}" for condition in chunk_conditions)

    lines.append(settings)
    return "\n".join(lines)


def _build_cutover_chunk_sql(
    *,
    chunk: Chunk,
    target: str,
    table: TableProfile,
    source_target: str,
    target_columns: list[str],
    cutover_key: list[str],
    header: str,
    chunk_conditions: list[str],
    insert_settings: Mapping[str, str | int | float | bool] | None,
) -> str:
    """A cutover chunk copies the snapshot rows of the chunk whose key the
    shadow table does not hold yet (TS ``buildCutoverChunkSql``).

    Rows the mirror already wrote, and rows an earlier attempt of this chunk
    wrote, are skipped, so a retry never duplicates rows. The key set is
    narrowed to the chunk's range when the range is on columns the copy writes
    unchanged. ``select_sequential_consistency`` makes a SharedMergeTree
    replica read the parts other replicas committed, including mirrored rows.
    """
    columns = ", ".join(_quote_identifier(name) for name in target_columns)
    key = ", ".join(_quote_identifier(name) for name in cutover_key)
    copied = set(target_columns)
    shadow_conditions: list[str] = []
    for range_ in chunk.ranges:
        sort_key = _sort_key_at(table.sort_keys, range_.dimension_index)
        if sort_key is None or sort_key.name.strip("`") not in copied:
            continue
        shadow_conditions.extend(_build_range_bound_conditions(range_, sort_key))
    narrowed = f" WHERE {' AND '.join(shadow_conditions)}" if shadow_conditions else ""
    lines = [
        header,
        f"INSERT INTO {target} ({columns})",
        f"SELECT {columns}",
        f"FROM {source_target}",
        f"WHERE _partition_id = {_quote_sql_string(chunk.partition_id)}",
        *(f"  AND {condition}" for condition in chunk_conditions),
        f"  AND ({key}) NOT IN (SELECT {key} FROM {target}{narrowed})",
        f"SETTINGS {chunk_insert_settings_sql(insert_settings, cutover=True)}",
    ]
    return "\n".join(lines)


# ── WHERE-clause builders ────────────────────────────────────────────────────


def build_where_clause_from_ranges(
    partition_id: str,
    ranges: list[ChunkRange],
    sort_keys: list[SortKey],
) -> str:
    conditions = [f"_partition_id = {_quote_sql_string(partition_id)}"]

    for range_ in ranges:
        sort_key = _sort_key_at(sort_keys, range_.dimension_index)
        if sort_key is None:
            continue
        conditions.extend(_build_range_bound_conditions(range_, sort_key))

    return "\n  AND ".join(conditions)


def build_where_clause_from_chunk(chunk: Chunk, table: TableProfile) -> str:
    return build_where_clause_from_ranges(
        chunk.partition_id, chunk.ranges, table.sort_keys
    )


def build_estimate_sql(
    filter_: EstimateFilter,
    sort_keys: list[SortKey],
    context: PlannerContext,
    row_probe_strategy: RowProbeStrategy,
) -> str:
    where_clause = _build_where_clause_from_filter(filter_, sort_keys)
    if row_probe_strategy == "count":
        return (
            f"SELECT count() AS cnt FROM {context.database}.{context.table} "
            f"WHERE {where_clause}"
        )
    return (
        f"EXPLAIN ESTIMATE SELECT count() FROM {context.database}.{context.table} "
        f"WHERE {where_clause}"
    )


def build_count_sql(
    filter_: EstimateFilter,
    sort_keys: list[SortKey],
    *,
    database: str,
    table: str,
) -> str:
    where_clause = _build_where_clause_from_filter(filter_, sort_keys)
    return f"SELECT count() AS cnt FROM {database}.{table} WHERE {where_clause}"


# ── Materialized-view query rewriting ────────────────────────────────────────


def rewrite_select_columns(query: str, target_columns: list[str]) -> str:
    """Reorder a materialized-view ``SELECT ... FROM ...`` projection to match
    the target table's column order. Projection items are matched to target
    columns by their alias (``expr AS alias``); unmatched target columns fall
    through as bare column references. Returns the query untouched when no
    top-level ``SELECT``/``FROM`` pair is found (e.g. a non-SELECT statement).
    """
    trimmed = _js_trim_end(query)

    bounds = _find_select_projection_bounds(trimmed)
    if bounds is None:
        return query
    select_pos, from_pos = bounds

    projection_start = select_pos + len("SELECT")
    raw_projection = _js_trim(trimmed[projection_start:from_pos])
    prefix, projection = _split_projection_prefix(raw_projection)

    items = [_js_trim(item) for item in split_top_level(projection, ",")]
    alias_map = _build_alias_map(items)

    rewritten = [alias_map.get(column, column) for column in target_columns]
    return (
        f"{trimmed[:projection_start]} {prefix}{', '.join(rewritten)}"
        f"\n{trimmed[from_pos:]}"
    )


def extract_source_table_ref(query: str) -> dict[str, str] | None:
    """Extract the primary source table an mv_replay backfill must chunk
    against — the table read by the first top-level ``FROM`` in a materialized
    view's ``SELECT``. Chunk conditions (``_partition_id``, sort-key ranges)
    are injected into that SELECT and run against this source, so its physical
    metadata is what sizing must introspect, not the (legitimately empty)
    target.

    Handles ``db.table``, bare ``table``, and backtick-quoted identifiers,
    ignoring a trailing alias or clause. Returns ``None`` when the ``FROM``
    target is a subquery, a table function, or otherwise not a plain table
    reference — the caller decides how to treat an unresolvable source.
    """
    from_hit = next(
        (hit for hit in find_top_level_keywords(query, ["FROM"]) if hit[0] == "FROM"),
        None,
    )
    if from_hit is None:
        return None

    token = _read_first_table_token(query[from_hit[1] + len("FROM") :])
    if token is None:
        return None

    return _parse_table_identifier(token)


def _read_first_table_token(text: str) -> str | None:
    """Read the identifier immediately following ``FROM``. Stops at the first
    whitespace, comma, or closing paren (an alias or trailing clause). Returns
    ``None`` for a subquery (``FROM (…)``) or table function (``name(…)``),
    which are not plain table references.
    """
    index = 0
    while index < len(text) and _is_js_space(text[index]):
        index += 1
    if index >= len(text) or text[index] == "(":
        return None

    token = ""
    in_backtick = False
    while index < len(text):
        char = text[index]
        if char == "`":
            in_backtick = not in_backtick
            token += char
            index += 1
            continue
        if in_backtick:
            token += char
            index += 1
            continue
        if char == "(":
            return None  # table function, e.g. numbers(10)
        if _is_js_space(char) or char in {",", ")"}:
            break
        token += char
        index += 1

    return token if len(token) > 0 else None


def _parse_table_identifier(ref: str) -> dict[str, str] | None:
    """Split a possibly-qualified, possibly-backticked identifier into db/table."""
    segments: list[str] = []
    current = ""
    in_backtick = False
    for char in ref:
        if char == "`":
            in_backtick = not in_backtick
            continue
        if char == "." and not in_backtick:
            segments.append(current)
            current = ""
            continue
        current += char
    segments.append(current)

    if len(segments) == 1:
        table = segments[0]
        return {"table": table} if table else None
    if len(segments) == 2:  # noqa: PLR2004 — db.table
        database, table = segments
        return {"database": database, "table": table} if database and table else None
    return None  # db.schema.table or malformed — unsupported


def inject_sort_key_filter(
    query: str,
    sort_key_column: str,
    category: SortKeyCategory,
    from_: str,
    to: str,
) -> str:
    if category == "datetime":
        condition = (
            f"{sort_key_column} >= parseDateTimeBestEffort({_quote_sql_string(from_)})\n"
            f"  AND {sort_key_column} < parseDateTimeBestEffort({_quote_sql_string(to)})"
        )
    elif category == "string":
        condition = (
            f"{sort_key_column} >= unhex('{latin1_bytes(from_).hex()}')\n"
            f"  AND {sort_key_column} < unhex('{latin1_bytes(to).hex()}')"
        )
    else:
        condition = (
            f"{sort_key_column} >= {_quote_sql_string(from_)}\n"
            f"  AND {sort_key_column} < {_quote_sql_string(to)}"
        )

    return _inject_where_condition(query, condition)


def _find_select_projection_bounds(sql: str) -> tuple[int, int] | None:
    """Locate the top-level ``SELECT`` and the first top-level ``FROM`` after it."""
    hits = find_top_level_keywords(sql, ["SELECT", "FROM"])

    select_pos = next((hit[1] for hit in hits if hit[0] == "SELECT"), -1)
    if select_pos == -1:
        return None

    from_pos = next(
        (hit[1] for hit in hits if hit[0] == "FROM" and hit[1] > select_pos), -1
    )
    if from_pos == -1:
        return None

    return select_pos, from_pos


# JS `/^DISTINCT\b\s*/i`: `\b` is an ASCII word boundary and `\s` is the JS
# whitespace class — Python's `\b`/`\s` differ (Unicode word chars; U+0085 in,
# U+FEFF out), so both are spelled out explicitly.
_DISTINCT_RE = re.compile(
    f"^DISTINCT(?![0-9A-Za-z_])[{_JS_WS_CLASS}]*", re.IGNORECASE
)


def _split_projection_prefix(raw_projection: str) -> tuple[str, str]:
    """Peel a leading ``DISTINCT`` off a projection so it survives the rewrite."""
    distinct_match = _DISTINCT_RE.match(raw_projection)
    if distinct_match is None:
        return "", raw_projection

    prefix = distinct_match.group(0)
    return prefix, _js_trim(raw_projection[len(prefix) :])


def _build_alias_map(items: list[str]) -> dict[str, str]:
    """Map each aliased projection item (``expr AS alias``) to its full source text."""
    alias_map: dict[str, str] = {}

    for item in items:
        if item == "*":
            continue
        alias = _find_column_alias(item)
        if alias is not None:
            alias_map[alias] = item

    return alias_map


def _find_column_alias(item: str) -> str | None:
    """Return the alias of a projection item, i.e. the text after its last
    top-level ``AS``."""
    hits = find_top_level_keywords(item, ["AS"])
    if not hits:
        return None
    as_hit = hits[-1]
    return _js_trim(item[as_hit[1] + len("AS") :])


def _inject_partition_filter(query: str, partition_id: str) -> str:
    return _inject_where_condition(
        query, f"_partition_id = {_quote_sql_string(partition_id)}"
    )


def _inject_where_condition(query: str, condition: str) -> str:
    """Insert ``condition`` into ``query``'s WHERE clause, appending with
    ``AND`` when a top-level ``WHERE`` already exists and inserting a fresh
    ``WHERE`` otherwise. The condition is placed before the first trailing
    clause (GROUP BY, ORDER BY, …) so it always lands inside the WHERE.
    """
    trimmed = _js_trim_end(query)
    hits = find_top_level_keywords(trimmed, _TRAILING_CLAUSE_KEYWORDS)

    where_hit = next((hit for hit in hits if hit[0] == "WHERE"), None)
    trailing = [
        hit
        for hit in hits
        if hit[0] != "WHERE" and (where_hit is None or hit[1] > where_hit[1])
    ]
    first_trailing = trailing[0] if trailing else None

    insert_at = first_trailing[1] if first_trailing is not None else len(trimmed)
    before = _js_trim_end(trimmed[:insert_at])
    after = trimmed[insert_at:]

    if where_hit is not None:
        return f"{before}\n  AND {condition}" + (f"\n{after}" if after else "")

    return f"{before}\nWHERE {condition}" + (f"\n{after}" if after else "")


# ── SQL string scanner (shared low-level) ────────────────────────────────────
#
# `find_top_level_keywords` and `split_top_level` are exported for direct unit
# testing of the quote/paren-skipping scan they share. They are intentionally
# NOT re-exported through the package entry point (`sdk.py`) — the package's
# public API is unchanged.

KeywordHit = tuple[str, int]


def _scan_sql_tokens(
    sql: str,
    visit: Callable[[str, int, int], None],
) -> None:
    """Walk ``sql`` character by character, tracking parenthesis depth and
    skipping single-quoted string literals (with backslash escapes). ``visit``
    is invoked for every character that lies outside a string literal and is
    not a parenthesis, receiving the current paren depth.

    This is the one primitive behind every SQL-structure scan in this module:
    top-level keyword detection and top-level delimiter splitting both build on
    it so the quote/paren bookkeeping lives in exactly one place.
    """
    depth = 0
    index = 0

    while index < len(sql):
        char = sql[index]
        if char == "(":
            depth += 1
            index += 1
            continue
        if char == ")":
            depth -= 1
            index += 1
            continue
        if char == "'":
            index += 1
            while index < len(sql) and sql[index] != "'":
                if sql[index] == "\\":
                    index += 1
                index += 1
            index += 1
            continue
        visit(char, index, depth)
        index += 1


def find_top_level_keywords(
    sql: str, keywords: tuple[str, ...] | list[str]
) -> list[KeywordHit]:
    """Find each occurrence of ``keywords`` that starts at the top level (paren
    depth 0), on a word boundary (preceded by whitespace or start-of-string and
    followed by whitespace or end-of-string). Matching is case-insensitive;
    hits are returned in ascending position order.
    """
    upper = sql.upper()
    hits: list[KeywordHit] = []

    def visit(_char: str, index: int, depth: int) -> None:
        if depth != 0:
            return
        if index > 0 and not _is_js_space(sql[index - 1]):
            return

        keyword = next(
            (
                candidate
                for candidate in keywords
                if _keyword_starts_at(sql, upper, index, candidate)
            ),
            None,
        )
        if keyword is not None:
            hits.append((keyword, index))

    _scan_sql_tokens(sql, visit)

    return hits


def _keyword_starts_at(sql: str, upper: str, index: int, keyword: str) -> bool:
    """Whether ``keyword`` starts at ``index`` on a trailing word boundary
    (case-insensitive)."""
    if not upper.startswith(keyword, index):
        return False
    after = index + len(keyword)
    return after >= len(sql) or _is_js_space(sql[after])


def split_top_level(sql: str, delimiter: str) -> list[str]:
    """Split ``sql`` on every top-level (paren depth 0) occurrence of
    ``delimiter``."""
    segments: list[str] = []
    state = {"start": 0}

    def visit(char: str, index: int, depth: int) -> None:
        if depth == 0 and char == delimiter:
            segments.append(sql[state["start"] : index])
            state["start"] = index + 1

    _scan_sql_tokens(sql, visit)
    segments.append(sql[state["start"] :])

    return segments


# ── Value formatting & condition helpers ─────────────────────────────────────


def _quote_identifier(name: str) -> str:
    escaped = name.replace("\\", "\\\\").replace("`", "\\`")
    return f"`{escaped}`"


def _quote_sql_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def _format_bound(value: str, sort_key: SortKey) -> str:
    if sort_key.category == "datetime":
        return f"parseDateTimeBestEffort({_quote_sql_string(value)})"

    if sort_key.category == "string":
        return f"unhex('{latin1_bytes(value).hex()}')"

    # A bare string literal is converted to the column type, but the analyzer
    # also treats it as the same constant as an equal ``_partition_id`` literal:
    # from ``_partition_id = '3' AND id >= '3' AND id < '133334'`` it derives
    # ``_partition_id < '133334'``, a string comparison that is false, and the
    # filter matches nothing (chkit#826). A typed constant keeps the conversion
    # and never equals the String partition id.
    return f"CAST({_quote_sql_string(value)}, {_quote_sql_string(sort_key.type)})"


def _build_range_bound_conditions(range_: ChunkRange, sort_key: SortKey) -> list[str]:
    """Build the ``>= from`` / ``< to`` conditions for a single range on
    ``sort_key``."""
    conditions: list[str] = []

    if range_.from_ is not None:
        conditions.append(f"{sort_key.name} >= {_format_bound(range_.from_, sort_key)}")
    if range_.to is not None:
        conditions.append(f"{sort_key.name} < {_format_bound(range_.to, sort_key)}")

    return conditions


def _build_settings_clause(
    token: str,
    insert_settings: Mapping[str, str | int | float | bool] | None = None,
) -> str:
    # ``INSERT INTO t SELECT *`` fills only ``t``'s insertable columns, so ``*``
    # must expand to the same set. A profile with ``asterisk_include_*_columns = 1``
    # adds MATERIALIZED/ALIAS columns to ``*``: copy mode then fails on a
    # column-count mismatch and an mv_replay ``SELECT *`` can shift values into
    # the wrong target columns. Query-level SETTINGS override the profile and
    # cover every ``*`` in the query, including each UNION ALL branch.
    # Per-chunk insert settings from the plugin config (e.g. max_insert_threads,
    # min_insert_block_size_rows) follow what chkit writes itself.
    return f"SETTINGS {chunk_insert_settings_sql(insert_settings, token=token)}"


def _render_insert_setting_value(value: str | int | float | bool) -> str:
    """JS template rendering: strings single-quoted (``\\`` escaped as
    ``\\\\`` and ``'`` as ``\\'``, so a value cannot close its quote), booleans
    as ``true``/``false``, numbers via ``String(number)``."""
    if isinstance(value, str):
        escaped = value.replace("\\", "\\\\").replace("'", "\\'")
        return f"'{escaped}'"
    if isinstance(value, bool):
        return "true" if value else "false"
    return js_number_to_string(float(value)) if isinstance(value, float) else str(value)


def _sort_key_at(sort_keys: list[SortKey], index: int) -> SortKey | None:
    if 0 <= index < len(sort_keys):
        return sort_keys[index]
    return None


def _build_chunk_conditions(chunk: Chunk, sort_keys: list[SortKey]) -> list[str]:
    conditions: list[str] = []
    for range_ in chunk.ranges:
        sort_key = _sort_key_at(sort_keys, range_.dimension_index)
        if sort_key is None:
            continue
        conditions.extend(_build_range_bound_conditions(range_, sort_key))
    return conditions


def _build_where_clause_from_filter(
    filter_: EstimateFilter, sort_keys: list[SortKey]
) -> str:
    conditions = [f"_partition_id = {_quote_sql_string(filter_.partition_id)}"]

    for range_ in filter_.ranges:
        sort_key = _sort_key_at(sort_keys, range_.dimension_index)
        if sort_key is None:
            continue

        if (
            filter_.exact_dimension_index == range_.dimension_index
            and filter_.exact_value is not None
        ):
            conditions.append(
                f"{sort_key.name} = {_format_bound(filter_.exact_value, sort_key)}"
            )
            continue

        conditions.extend(_build_range_bound_conditions(range_, sort_key))

    return " AND ".join(conditions)


__all__ = [
    "build_chunk_execution_sql",
    "build_count_sql",
    "build_estimate_sql",
    "build_where_clause_from_chunk",
    "build_where_clause_from_ranges",
    "extract_source_table_ref",
    "find_top_level_keywords",
    "inject_sort_key_filter",
    "rewrite_select_columns",
    "split_top_level",
]
