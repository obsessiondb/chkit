"""Validation rules for schema definitions."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Iterable
from typing import Final

from chkit.core.canonical import definition_key
from chkit.core.codec import canonicalize_codec, is_general_codec, is_raw_codec
from chkit.core.column_default import (
    LEGACY_EXPRESSION_PREFIX,
    column_type_accepts_string_literal,
    parse_column_default,
    reads_unparsable_ephemeral_literal_as_null,
    render_default,
    starts_with_function_call,
    stores_unparsable_literal_as_null,
    trim_expression,
)
from chkit.core.kafka import is_kafka_engine
from chkit.core.key_clause import (
    is_plain_column_reference,
    normalize_key_columns,
    split_top_level_comma,
)
from chkit.core.model import (
    ChxValidationError,
    ColumnDefaultKind,
    ColumnDefinition,
    DictionaryDefinition,
    MaterializedViewDefinition,
    SchemaDefinition,
    SQLExpression,
    TableDefinition,
    ValidationIssue,
    ValidationIssueCode,
)
from chkit.core.projection import is_index_projection, normalize_projection_index
from chkit.core.sql_lexer import SQLToken, js_trim, tokenize_sql
from chkit.core.sql_normalizer import normalize_sql_fragment
from chkit.core.sql_scan import strip_wrapping_parens
from chkit.core.text_index import render_text_index_type
from chkit.core.text_index_sql import text_sql_tokens


def _push(
    issues: list[ValidationIssue],
    definition: SchemaDefinition,
    code: ValidationIssueCode,
    message: str,
) -> None:
    issues.append(
        ValidationIssue(
            code=code,
            kind=definition.kind,
            database=definition.database,
            name=definition.name,
            message=message,
        )
    )


def _validate_column_codec(
    definition: TableDefinition, column: ColumnDefinition, issues: list[ValidationIssue]
) -> None:
    if column.codec is None:
        return
    steps = canonicalize_codec(column.codec)
    if len(steps) == 0:
        _push(
            issues,
            definition,
            "codec_chain_empty",
            f'Table {definition.database}.{definition.name} column "{column.name}" '
            f"codec chain is empty; provide at least one codec or omit the field",
        )
        return

    general_count = 0
    general_index = -1
    for i, step in enumerate(steps):
        if is_raw_codec(step):
            continue
        if is_general_codec(step):
            general_count += 1
            general_index = i

    if general_count > 1:
        _push(
            issues,
            definition,
            "codec_chain_multiple_general",
            f'Table {definition.database}.{definition.name} column "{column.name}" '
            f"codec chain has more than one general codec; only one general codec is "
            f"allowed at the end of a chain",
        )
        return

    if len(steps) > 1 and general_count == 1 and general_index != len(steps) - 1:
        _push(
            issues,
            definition,
            "codec_chain_must_end_with_general",
            f'Table {definition.database}.{definition.name} column "{column.name}" '
            f"codec chain must end with a general codec "
            f"(NONE, LZ4, LZ4HC, ZSTD, T64, GCD, ALP)",
        )


def _validate_indexes(definition: TableDefinition, issues: list[ValidationIssue]) -> None:
    index_seen: set[str] = set()
    for index in definition.indexes or []:
        if index.name in index_seen:
            _push(
                issues,
                definition,
                "duplicate_index_name",
                f'Table {definition.database}.{definition.name} '
                f'has duplicate index name "{index.name}"',
            )
            continue
        index_seen.add(index.name)
        if index.type == "text":
            try:
                render_text_index_type(index)
            except ValueError as exc:
                _push(issues, definition, "text_index_invalid_parameters",
                      f'Text index "{index.name}": {exc}')


def _validate_kafka_table(definition: TableDefinition, issues: list[ValidationIssue]) -> None:
    if not is_kafka_engine(definition.engine):
        return
    label = f"Kafka table {definition.database}.{definition.name}"
    clauses = {
        "primaryKey": definition.primary_key,
        "orderBy": definition.order_by,
        "uniqueKey": definition.unique_key,
        "partitionBy": definition.partition_by,
        "ttl": definition.ttl,
        "indexes": definition.indexes,
        "projections": definition.projections,
    }
    for field, value in clauses.items():
        if value:
            _push(
                issues,
                definition,
                "kafka_unsupported_clause",
                f"{label} does not support {field}. Put storage clauses on the destination table.",
            )
    for column in definition.columns:
        if column.default is not None or (column.default_kind or "DEFAULT") != "DEFAULT":
            _push(
                issues,
                definition,
                "kafka_column_default",
                f'{label} column "{column.name}" cannot have a DEFAULT, MATERIALIZED, '
                "ALIAS, or EPHEMERAL definition. Compute values in the materialized view.",
            )
    settings = definition.settings or {}
    if re.fullmatch(r"Kafka\s*(?:\(\s*\))?", definition.engine.strip(), re.IGNORECASE):
        for key in ("kafka_broker_list", "kafka_topic_list", "kafka_group_name", "kafka_format"):
            setting = settings.get(key)
            if not isinstance(setting, str) or not setting.strip():
                _push(
                    issues,
                    definition,
                    "kafka_missing_setting",
                    f"{label} requires a nonempty {key} string "
                    "(or engine arguments / a named collection).",
                )
    for key, setting in settings.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or (
            isinstance(setting, float) and not math.isfinite(setting)
        ):
            _push(
                issues,
                definition,
                "kafka_invalid_setting",
                f"{label} has an invalid setting key or value: {key}.",
            )
        if key == "kafka_auto_offset_reset":
            _push(
                issues,
                definition,
                "kafka_invalid_setting",
                "kafka_auto_offset_reset is not a Kafka table setting on standard ClickHouse. "
                "Configure auto_offset_reset in the server Kafka configuration.",
            )
        if re.search(r"password|secret|token", key, re.IGNORECASE) and setting == "[HIDDEN]":
            _push(
                issues,
                definition,
                "kafka_invalid_setting",
                f"Kafka setting {key} was redacted by ClickHouse. Restore the credential or "
                "use server-side configuration before generating migrations.",
            )


def _validate_unstored_column_codec(
    definition: TableDefinition, column: ColumnDefinition, issues: list[ValidationIssue]
) -> None:
    kind = column.default_kind
    # A bare `EPHEMERAL CODEC(...)` parses the codec as the default expression;
    # after an EPHEMERAL default or comment ClickHouse accepts the codec.
    bare_ephemeral = kind == "EPHEMERAL" and column.default is None and not column.comment
    if column.codec is not None and (kind == "ALIAS" or bare_ephemeral):
        _push(issues, definition, "column_kind_codec_unsupported",
              f'Column "{column.name}" is {kind} and cannot have a codec; '
              "ClickHouse stores no data for it.")


def _validate_column_default(
    definition: TableDefinition, column: ColumnDefinition, issues: list[ValidationIssue]
) -> None:
    """Default checks (#216, #234, #237).

    Runs on raw definitions (``to_create_sql``) and canonical ones
    (``plan_diff``), where ``SQLExpression`` is already the ``fn:`` string;
    ``parse_column_default`` reads both. Pydantic already rejects a default
    object that is not an ``SQLExpression``.
    """
    subject = f'Table {definition.database}.{definition.name} column "{column.name}"'
    kind: ColumnDefaultKind = column.default_kind or "DEFAULT"
    value = column.default
    if value is None:
        if kind in ("MATERIALIZED", "ALIAS"):
            _push(issues, definition, "column_expression_required",
                  f"{subject} is {kind} and requires a non-empty expression. "
                  'Set default: { expression: "<sql>" }.')
        return
    parsed = parse_column_default(value)
    if parsed.kind == "expression":
        _validate_default_expression(definition, subject, kind, parsed.sql, issues)
        return
    if not isinstance(parsed.value, str):
        return
    # A string renders as a quoted literal for every kind. MATERIALIZED and
    # ALIAS compute their value, so there it is almost always SQL written
    # without { expression }; a constant string is spelled { expression: "'text'" }.
    if kind in ("MATERIALIZED", "ALIAS"):
        _push(issues, definition, "column_expression_requires_fn",
              _describe_plain_string_expression(subject, kind, parsed.value))
        return
    # DEFAULT and EPHEMERAL keep a string as a literal. On a column that cannot
    # hold a string, one that starts with a function call is SQL written
    # without { expression }: ClickHouse rejects the literal, or reads it as NULL (#234).
    if not starts_with_function_call(parsed.value):
        return
    type_ = js_trim(column.type)
    if column_type_accepts_string_literal(type_):
        return
    effective_type = f"Nullable({type_})" if column.nullable else type_
    _push(issues, definition, "column_default_looks_like_expression",
          _describe_quoted_function_default(subject, kind, effective_type, parsed.value))


def _validate_default_expression(
    definition: TableDefinition,
    subject: str,
    kind: ColumnDefaultKind,
    sql: str,
    issues: list[ValidationIssue],
) -> None:
    rendered = render_default(SQLExpression(expression=sql))
    if rendered == "":
        removable = kind not in ("MATERIALIZED", "ALIAS")
        _push(issues, definition, "column_expression_required",
              f"{subject} has an empty default expression. Put the SQL in "
              f'default: {{ expression: "<sql>" }}{", or remove default" if removable else ""}.')
        return
    # The expression is rendered mid-statement, so an open string, quoted
    # identifier or block comment would swallow the SQL after it, the next
    # statements of the migration file included.
    tokens = tokenize_sql(sql)
    unterminated = next((token for token in tokens if not token.terminated), None)
    if unterminated is not None:
        _push(issues, definition, "column_default_invalid",
              f"{subject} has default expression {_js_string(sql)} with an unterminated "
              f"{_describe_open_token(unterminated)}, which would swallow the rest of the "
              "generated SQL. Close it or remove it.")
    # ClickHouse reads `#` as a comment only before a space or `!`; any other
    # `#` is a syntax error. Report it here instead of at migrate: at the end of
    # an expression it used to turn the ` COMMENT` or ` CODEC` rendered after
    # it into a comment, and the statement applied without them.
    if any(_is_stray_hash(token) for token in tokens):
        _push(issues, definition, "column_default_invalid",
              f"{subject} has default expression {_js_string(sql)} with a # that starts no "
              "comment, which ClickHouse rejects. Remove it, or put a space after it to "
              'start a comment: "# note".')
    # The prefix only marks a plain string as SQL. Inside an expression it is
    # text: `SQLExpression(expression='fn:now()')` would render `DEFAULT fn:now()`.
    if _keeps_legacy_prefix(rendered):
        unprefixed = js_trim(rendered[len(LEGACY_EXPRESSION_PREFIX) :])
        _push(issues, definition, "column_default_invalid",
              f"{subject} has default expression {_js_string(rendered)}, which keeps the "
              f"legacy fn: prefix and would render {kind} {rendered}, a syntax error. Remove "
              f"the prefix: default: {{ expression: {_js_string(unprefixed)} }}.")


def _passes_expression_checks(sql: str) -> bool:
    # Whether _validate_default_expression accepts `sql`, so that a message can
    # suggest it as the fix.
    rendered = render_default(SQLExpression(expression=sql))
    return (
        rendered != ""
        and not _keeps_legacy_prefix(rendered)
        and all(token.terminated and not _is_stray_hash(token) for token in tokenize_sql(sql))
    )


def _keeps_legacy_prefix(sql: str) -> bool:
    # `fn::String` is not a leftover prefix: it casts a column named fn.
    prefix_length = len(LEGACY_EXPRESSION_PREFIX)
    next_char = sql[prefix_length : prefix_length + 1]
    return sql.startswith(LEGACY_EXPRESSION_PREFIX) and next_char != ":"


def _is_stray_hash(token: SQLToken) -> bool:
    return token.kind == "punctuation" and token.text == "#"


def _describe_open_token(token: SQLToken) -> str:
    # The lexer leaves only strings, quoted identifiers and block comments open.
    if token.kind == "block_comment":
        return "block comment"
    if token.kind == "quoted_identifier":
        return "quoted identifier"
    return "string literal"


def _describe_plain_string_expression(subject: str, kind: ColumnDefaultKind, value: str) -> str:
    literal = render_default(value)
    fix = _suggested_expression(value)
    if fix is None:
        as_sql = 'default: { expression: "<sql>" } for a SQL expression'
    else:
        expression, rendered = fix
        legacy = _js_string(f"{LEGACY_EXPRESSION_PREFIX}{expression}")
        as_sql = (
            f"default: {{ expression: {_js_string(expression)} }} to render {kind} {rendered} "
            f"(legacy spelling: {legacy})"
        )
    return (
        f"{subject} is {kind} with plain string default {_js_string(value)}, which renders "
        f"as the quoted literal {literal} instead of SQL. Use {as_sql}, or "
        f"default: {{ expression: {_js_string(literal)} }} for a constant string."
    )


def _describe_quoted_function_default(
    subject: str, kind: ColumnDefaultKind, effective_type: str, value: str
) -> str:
    # `effective_type` is the type as rendered, with `nullable=True` applied.
    # The quoted-text option is for a type chkit misreads, such as a string type
    # it does not know: on the types it recognizes, that literal is what fails.
    literal = render_default(value)
    fix = _suggested_expression(value)
    ephemeral = kind == "EPHEMERAL"
    reads_null = (
        reads_unparsable_ephemeral_literal_as_null(effective_type)
        if ephemeral
        else stores_unparsable_literal_as_null(effective_type)
    )
    if reads_null:
        outcome = (
            f"which ClickHouse accepts for type {effective_type} but "
            f"{'reads' if ephemeral else 'stores'} as NULL"
        )
    else:
        outcome = f"which ClickHouse rejects for type {effective_type}"
    if fix is None:
        as_sql = 'Use default: { expression: "<sql>" } for a SQL expression.'
    else:
        expression, rendered = fix
        as_sql = (
            f"Use default: {{ expression: {_js_string(expression)} }} to render {kind} {rendered}."
        )
    return (
        f"{subject} has default {_js_string(value)}, a plain string that looks like a SQL "
        f"function call. Plain strings render as quoted literals ({kind} {literal}), "
        f"{outcome}. {as_sql} If chkit misjudged the type and the column should "
        f"{'hold' if ephemeral else 'store'} this text, use "
        f"default: {{ expression: {_js_string(literal)} }}."
    )


def _suggested_expression(value: str) -> tuple[str, str] | None:
    """The plain string as the ``{ expression }`` a message suggests.

    Returns the expression and the SQL it renders on one line, or ``None`` when
    validation would reject that expression too (no SQL, a leftover ``fn:``
    prefix, an unterminated token or a stray ``#``).
    """
    expression = trim_expression(value)
    if not _passes_expression_checks(expression):
        return None
    rendered = "".join(
        " " if token.kind == "whitespace" else token.text
        for token in tokenize_sql(render_default(SQLExpression(expression=expression)))
    )
    return expression, rendered


def _js_string(value: str) -> str:
    """``JSON.stringify`` of a string, so messages match the TS port byte for byte."""
    return json.dumps(value, ensure_ascii=False)


def _validate_unstored_column_references(
    definition: TableDefinition, issues: list[ValidationIssue]
) -> None:
    """Flag ALIAS/EPHEMERAL columns named directly where ClickHouse needs a stored column.

    References inside larger expressions (``toStartOfDay(day)``, TTL) are left for
    ClickHouse to report at migrate time.
    """
    unstored = {c.name: c.default_kind for c in definition.columns
                if c.default_kind in {"ALIAS", "EPHEMERAL"}}
    if not unstored:
        return
    label = f"Table {definition.database}.{definition.name}"
    # Fragments are read without their comments, as canonicalization stores
    # them (#232), so raw definitions (to_create_sql) and canonical ones
    # (plan_diff) check the same fragment text.
    partition = strip_wrapping_parens(normalize_sql_fragment(definition.partition_by or ""))
    references = [
        *(("orderBy", part) for part in normalize_key_columns(definition.order_by)),
        *(("primaryKey", part) for part in normalize_key_columns(definition.primary_key)),
        *(("partitionBy", part) for part in split_top_level_comma(partition)),
        *(("engine", part) for part in _engine_arguments(definition.engine)),
        *(
            (f'index "{index.name}"', normalize_sql_fragment(index.expression))
            for index in definition.indexes or []
        ),
    ]
    for field, part in references:
        name = _unquote(part)
        kind = unstored.get(name)
        # ClickHouse indexes an ALIAS column by its expression, but not an EPHEMERAL one.
        if kind is not None and (kind == "EPHEMERAL" or not field.startswith("index")):
            _push(issues, definition, "column_kind_not_stored",
                  f'{label} {field} references {kind} column "{name}", which ClickHouse '
                  "does not store; use a MATERIALIZED column instead.")
    for projection in definition.projections or []:
        try:
            tokens = text_sql_tokens(
                normalize_sql_fragment(
                    projection.index if projection.index is not None else projection.query or ""
                )
            )
        except (ValueError, IndexError):
            continue
        # A token followed by `(` is a function that merely shares the column's name,
        # and one after AS names an output alias.
        names = [_unquote(token) for token in tokens]
        before, after = ["", *tokens[:-1]], [*tokens[1:], ""]
        for name in dict.fromkeys(
            name
            for name, prev, nxt in zip(names, before, after, strict=True)
            if unstored.get(name) == "EPHEMERAL" and nxt != "(" and prev.upper() != "AS"
        ):
            _push(issues, definition, "column_ephemeral_in_projection",
                  f'{label} projection "{projection.name}" reads EPHEMERAL column "{name}", '
                  "which ClickHouse does not store, so the table is rejected or every INSERT "
                  "fails. Use a MATERIALIZED column instead.")


def _engine_arguments(engine: str) -> list[str]:
    """Bare engine arguments, with one tuple level flattened: ``SummingMergeTree((a, b))``."""
    # Only MergeTree-family parameters name columns; e.g. Distributed takes a cluster name.
    match = re.fullmatch(r"\s*\w*MergeTree\s*\((.*)\)\s*", engine, re.DOTALL)
    arguments = split_top_level_comma(match.group(1)) if match else []
    parts = [p for arg in arguments for p in split_top_level_comma(strip_wrapping_parens(arg))]
    return [part for part in parts if not part.startswith("'")]


def _unquote(name: str) -> str:
    """A column name with its backtick or double-quote identifier quotes removed."""
    name = name.strip()
    return name[1:-1] if len(name) > 1 and name[0] == name[-1] and name[0] in "`\"" else name


def _validate_table(definition: TableDefinition, issues: list[ValidationIssue]) -> None:
    kafka = is_kafka_engine(definition.engine)
    _validate_kafka_table(definition, issues)
    column_seen: set[str] = set()
    column_set: set[str] = set()
    for column in definition.columns:
        if column.name in column_seen:
            _push(
                issues,
                definition,
                "duplicate_column_name",
                f'Table {definition.database}.{definition.name} '
                f'has duplicate column name "{column.name}"',
            )
            continue
        column_seen.add(column.name)
        column_set.add(column.name)
        # Kafka already rejects every default and column kind
        # (kafka_column_default), which also covers the codec of an ALIAS or
        # EPHEMERAL column; one error per mistake.
        if not kafka:
            _validate_unstored_column_codec(definition, column, issues)
        _validate_column_codec(definition, column, issues)
        if not kafka:
            _validate_column_default(definition, column, issues)

    _validate_indexes(definition, issues)

    projection_seen: set[str] = set()
    for projection in definition.projections or []:
        if projection.name in projection_seen:
            _push(
                issues,
                definition,
                "duplicate_projection_name",
                f'Table {definition.database}.{definition.name} '
                f'has duplicate projection name "{projection.name}"',
            )
            continue
        projection_seen.add(projection.name)

        # A projection carrying both keys satisfies the model, so Pydantic
        # admits it. Renders as index-only and drops the SELECT body on the
        # floor.
        if projection.index is not None and projection.query is not None:
            _push(
                issues,
                definition,
                "projection_ambiguous_kind",
                f'Table {definition.database}.{definition.name} projection '
                f'"{projection.name}" sets both "query" and "index"; use '
                f'"query" for a SELECT projection or "index"/"type" for an '
                f"index-only projection",
            )
            continue

        if (
            is_index_projection(projection)
            and normalize_projection_index(projection.index or "") == ""
        ):
            _push(
                issues,
                definition,
                "projection_empty_index",
                f'Table {definition.database}.{definition.name} projection '
                f'"{projection.name}" has an empty index expression',
            )

    for col in normalize_key_columns(definition.primary_key):
        if is_plain_column_reference(col) and col not in column_set:
            _push(
                issues,
                definition,
                "primary_key_missing_column",
                f"Table {definition.database}.{definition.name} primaryKey "
                f'references missing column "{col}"',
            )

    for col in normalize_key_columns(definition.order_by):
        if is_plain_column_reference(col) and col not in column_set:
            _push(
                issues,
                definition,
                "order_by_missing_column",
                f"Table {definition.database}.{definition.name} orderBy "
                f'references missing column "{col}"',
            )

    _validate_unstored_column_references(definition, issues)


_INTERVAL_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^\s*\d+\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)"
    r"(\s+\d+\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR))*\s*$",
    re.IGNORECASE,
)

_REPLICATED_ENGINE_PATTERN: Final[re.Pattern[str]] = re.compile(r"^(Shared|Replicated)")


def _validate_interval(
    definition: MaterializedViewDefinition,
    issues: list[ValidationIssue],
    field: str,
    value: str | None,
) -> None:
    if value is None:
        return
    if _INTERVAL_PATTERN.match(value) is None:
        _push(
            issues,
            definition,
            "refresh_interval_format",
            f"Materialized view {definition.database}.{definition.name} "
            f'refresh.{field} "{value}" is not a valid interval '
            f'(expected e.g. "1 HOUR", "30 SECOND")',
        )


def _validate_materialized_view(
    definition: MaterializedViewDefinition,
    issues: list[ValidationIssue],
    definitions: list[SchemaDefinition],
) -> None:
    refresh = definition.refresh
    if refresh is None:
        return

    has_every = refresh.every is not None and len(refresh.every) > 0
    has_after = refresh.after is not None and len(refresh.after) > 0
    if not has_every and not has_after:
        _push(
            issues,
            definition,
            "refresh_requires_every_or_after",
            f"Materialized view {definition.database}.{definition.name} refresh "
            f'requires exactly one of "every" or "after"',
        )
    elif has_every and has_after:
        _push(
            issues,
            definition,
            "refresh_every_after_mutually_exclusive",
            f"Materialized view {definition.database}.{definition.name} refresh "
            f'specifies both "every" and "after"; choose one',
        )

    _validate_interval(definition, issues, "every", refresh.every)
    _validate_interval(definition, issues, "after", refresh.after)
    _validate_interval(definition, issues, "offset", refresh.offset)
    _validate_interval(definition, issues, "randomize", refresh.randomize)

    if (
        refresh.depends_on is not None
        and len(refresh.depends_on) > 0
        and has_after
        and not has_every
    ):
        _push(
            issues,
            definition,
            "refresh_depends_on_requires_every",
            f"Materialized view {definition.database}.{definition.name} uses "
            f"DEPENDS ON with REFRESH AFTER; ClickHouse only allows DEPENDS ON "
            f"with REFRESH EVERY.",
        )

    if not refresh.append:
        target: TableDefinition | None = None
        for other in definitions:
            if (
                isinstance(other, TableDefinition)
                and other.database == definition.to.database
                and other.name == definition.to.name
            ):
                target = other
                break
        if target is not None and _REPLICATED_ENGINE_PATTERN.match(target.engine) is not None:
            _push(
                issues,
                definition,
                "refresh_append_required_for_replicated_target",
                f"Materialized view {definition.database}.{definition.name} refreshes "
                f"a replicated target {target.database}.{target.name} ({target.engine}) "
                f"without APPEND. ClickHouse rejects this combination. Set "
                f"refresh.append = true, or target a non-replicated table.",
            )


def _validate_dictionary(  # noqa: PLR0912
    definition: DictionaryDefinition, issues: list[ValidationIssue]
) -> None:
    attribute_seen: set[str] = set()
    attribute_set: set[str] = set()
    for attribute in definition.attributes:
        if attribute.name in attribute_seen:
            _push(
                issues,
                definition,
                "duplicate_column_name",
                f"Dictionary {definition.database}.{definition.name} "
                f'has duplicate attribute name "{attribute.name}"',
            )
            continue
        attribute_seen.add(attribute.name)
        attribute_set.add(attribute.name)

        if attribute.default is not None and attribute.expression is not None:
            _push(
                issues,
                definition,
                "dictionary_attribute_default_expression_exclusive",
                f"Dictionary {definition.database}.{definition.name} attribute "
                f'"{attribute.name}" sets both "default" and "expression"; choose one',
            )

        if attribute.bidirectional and not attribute.hierarchical:
            _push(
                issues,
                definition,
                "dictionary_bidirectional_requires_hierarchical",
                f"Dictionary {definition.database}.{definition.name} attribute "
                f'"{attribute.name}" sets "bidirectional" without "hierarchical"; '
                f"bidirectional only applies to hierarchical attributes",
            )

    if len(definition.primary_key) == 0:
        _push(
            issues,
            definition,
            "dictionary_missing_primary_key",
            f"Dictionary {definition.database}.{definition.name} "
            f"requires a non-empty primaryKey",
        )
    else:
        for column in definition.primary_key:
            if column not in attribute_set:
                _push(
                    issues,
                    definition,
                    "dictionary_primary_key_missing_attribute",
                    f"Dictionary {definition.database}.{definition.name} primaryKey "
                    f'references missing attribute "{column}"',
                )

    if len(definition.source.strip()) == 0:
        _push(
            issues,
            definition,
            "dictionary_missing_source",
            f"Dictionary {definition.database}.{definition.name} "
            f'requires a non-empty "source"',
        )

    if len(definition.layout.strip()) == 0:
        _push(
            issues,
            definition,
            "dictionary_missing_layout",
            f"Dictionary {definition.database}.{definition.name} "
            f'requires a non-empty "layout"',
        )

    if len(definition.lifetime.strip()) == 0:
        _push(
            issues,
            definition,
            "dictionary_missing_lifetime",
            f"Dictionary {definition.database}.{definition.name} "
            f'requires a non-empty "lifetime"',
        )

    if definition.range is not None:
        for column in (definition.range.min, definition.range.max):
            if column not in attribute_set:
                _push(
                    issues,
                    definition,
                    "dictionary_range_missing_attribute",
                    f"Dictionary {definition.database}.{definition.name} range "
                    f'references missing attribute "{column}"',
                )


def validate_definitions(definitions: Iterable[SchemaDefinition]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    object_keys: set[str] = set()
    materialized: list[SchemaDefinition] = list(definitions)
    for definition in materialized:
        key = definition_key(definition)
        if key in object_keys:
            _push(
                issues,
                definition,
                "duplicate_object_name",
                f'Duplicate schema object definition '
                f'"{definition.kind}:{definition.database}.{definition.name}"',
            )
            continue
        object_keys.add(key)

        if isinstance(definition, TableDefinition):
            _validate_table(definition, issues)
        elif isinstance(definition, MaterializedViewDefinition):
            _validate_materialized_view(definition, issues, materialized)
        elif isinstance(definition, DictionaryDefinition):
            _validate_dictionary(definition, issues)

    return issues


def assert_valid_definitions(definitions: Iterable[SchemaDefinition]) -> None:
    issues = validate_definitions(definitions)
    if len(issues) > 0:
        raise ChxValidationError(issues)
