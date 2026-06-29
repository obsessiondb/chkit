"""Strict Pydantic v2 schema model for chkit.

Mirrors the TypeScript `@chkit/core` model with the same field names converted
to snake_case where required. All models are frozen and forbid extra fields to
guarantee that round-tripping a definition produces an equal object.
"""

from __future__ import annotations

import os
from typing import Annotated, Any, Final, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field
from pydantic.dataclasses import dataclass

_STRICT_MODEL_CONFIG: Final[ConfigDict] = ConfigDict(
    frozen=True,
    extra="forbid",
    strict=True,
    validate_assignment=True,
    arbitrary_types_allowed=False,
)


class _StrictModel(BaseModel):
    """Base for all chkit models.

    `frozen=True` makes instances hashable and immutable. `extra="forbid"`
    keeps schemas honest — typos surface as validation errors instead of
    being silently ignored.
    """

    model_config = _STRICT_MODEL_CONFIG


PrimitiveColumnType: TypeAlias = Literal[
    "String",
    "UInt8",
    "UInt16",
    "UInt32",
    "UInt64",
    "UInt128",
    "UInt256",
    "Int8",
    "Int16",
    "Int32",
    "Int64",
    "Int128",
    "Int256",
    "Float32",
    "Float64",
    "Bool",
    "Boolean",
    "Date",
    "DateTime",
    "DateTime64",
]


class _GeneralCodecSimple(_StrictModel):
    kind: Literal["NONE", "LZ4", "T64", "GCD", "ALP"]


class _CodecLZ4HC(_StrictModel):
    kind: Literal["LZ4HC"] = "LZ4HC"
    level: int | None = None


class _CodecZSTD(_StrictModel):
    kind: Literal["ZSTD"] = "ZSTD"
    level: int | None = None


GeneralColumnCodec: TypeAlias = _GeneralCodecSimple | _CodecLZ4HC | _CodecZSTD


_PreprocessorSize: TypeAlias = Literal[1, 2, 4, 8]


class _CodecDeltaLike(_StrictModel):
    kind: Literal["Delta", "DoubleDelta", "Gorilla"]
    size: _PreprocessorSize | None = None


class _CodecFPC(_StrictModel):
    kind: Literal["FPC"] = "FPC"
    level: int
    float_size: Literal[4, 8] = Field(..., alias="floatSize")

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


PreprocessingColumnCodec: TypeAlias = _CodecDeltaLike | _CodecFPC


class RawColumnCodec(_StrictModel):
    """Escape hatch for codecs the typed model does not cover.

    Canonicalization is whitespace-only, so round-trips are best-effort.
    """

    kind: Literal["raw"] = "raw"
    expression: str


ColumnCodec: TypeAlias = Annotated[
    GeneralColumnCodec | PreprocessingColumnCodec | RawColumnCodec,
    Field(discriminator="kind"),
]
"""Single codec atom — one step of a chain."""

ColumnCodecSpec: TypeAlias = ColumnCodec | list[ColumnCodec]
"""Either a single atom or a list of atoms (preprocessors then one general)."""


ColumnType: TypeAlias = PrimitiveColumnType | str


class ColumnDefinition(_StrictModel):
    name: str
    type: ColumnType
    renamed_from: str | None = Field(default=None, alias="renamedFrom")
    nullable: bool | None = None
    default: str | int | float | bool | None = None
    comment: str | None = None
    codec: ColumnCodecSpec | None = None

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class _SkipIndexBase(_StrictModel):
    name: str
    expression: str
    granularity: int


class SkipIndexMinmax(_SkipIndexBase):
    type: Literal["minmax"] = "minmax"


class SkipIndexSet(_SkipIndexBase):
    type: Literal["set"] = "set"
    max_rows: int = Field(..., alias="maxRows")

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class SkipIndexBloomFilter(_SkipIndexBase):
    type: Literal["bloom_filter"] = "bloom_filter"
    false_positive_rate: float | None = Field(default=None, alias="falsePositiveRate")

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class SkipIndexTokenBF(_SkipIndexBase):
    type: Literal["tokenbf_v1"] = "tokenbf_v1"
    size_bytes: int = Field(..., alias="sizeBytes")
    hash_functions: int = Field(..., alias="hashFunctions")
    random_seed: int = Field(..., alias="randomSeed")

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class SkipIndexNgramBF(_SkipIndexBase):
    type: Literal["ngrambf_v1"] = "ngrambf_v1"
    ngram_size: int = Field(..., alias="ngramSize")
    size_bytes: int = Field(..., alias="sizeBytes")
    hash_functions: int = Field(..., alias="hashFunctions")
    random_seed: int = Field(..., alias="randomSeed")

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


SkipIndexDefinition: TypeAlias = Annotated[
    SkipIndexMinmax
    | SkipIndexSet
    | SkipIndexBloomFilter
    | SkipIndexTokenBF
    | SkipIndexNgramBF,
    Field(discriminator="type"),
]


class ProjectionDefinition(_StrictModel):
    name: str
    query: str


SettingValue: TypeAlias = str | int | float | bool


class TableRef(_StrictModel):
    """Database-qualified object reference."""

    database: str
    name: str


class TableRenamedFrom(_StrictModel):
    database: str | None = None
    name: str


class TableDefinition(_StrictModel):
    kind: Literal["table"] = "table"
    database: str
    name: str
    renamed_from: TableRenamedFrom | None = Field(default=None, alias="renamedFrom")
    columns: list[ColumnDefinition]
    engine: str
    primary_key: list[str] = Field(..., alias="primaryKey")
    order_by: list[str] = Field(..., alias="orderBy")
    unique_key: list[str] | None = Field(default=None, alias="uniqueKey")
    partition_by: str | None = Field(default=None, alias="partitionBy")
    ttl: str | None = None
    settings: dict[str, SettingValue] | None = None
    indexes: list[SkipIndexDefinition] | None = None
    projections: list[ProjectionDefinition] | None = None
    comment: str | None = None

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class ViewDefinition(_StrictModel):
    kind: Literal["view"] = "view"
    database: str
    name: str
    as_: str = Field(..., alias="as")
    comment: str | None = None

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class MaterializedViewRefresh(_StrictModel):
    every: str | None = None
    after: str | None = None
    offset: str | None = None
    randomize: str | None = None
    depends_on: list[TableRef] | None = Field(default=None, alias="dependsOn")
    settings: dict[str, str | int | float] | None = None
    append: bool | None = None
    empty: bool | None = None

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class MaterializedViewDefinition(_StrictModel):
    kind: Literal["materialized_view"] = "materialized_view"
    database: str
    name: str
    to: TableRef
    refresh: MaterializedViewRefresh | None = None
    as_: str = Field(..., alias="as")
    comment: str | None = None

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


SchemaDefinition: TypeAlias = Annotated[
    TableDefinition | ViewDefinition | MaterializedViewDefinition,
    Field(discriminator="kind"),
]


class ChxCheckConfig(_StrictModel):
    fail_on_pending: bool | None = Field(default=None, alias="failOnPending")
    fail_on_checksum_mismatch: bool | None = Field(
        default=None, alias="failOnChecksumMismatch"
    )
    fail_on_drift: bool | None = Field(default=None, alias="failOnDrift")

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class ChxResolvedCheckConfig(_StrictModel):
    fail_on_pending: bool
    fail_on_checksum_mismatch: bool
    fail_on_drift: bool


class ChxSafetyConfig(_StrictModel):
    allow_destructive: bool | None = Field(default=None, alias="allowDestructive")

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class ChxResolvedSafetyConfig(_StrictModel):
    allow_destructive: bool


class ChxUserClickHouseConfig(_StrictModel):
    url: str
    username: str | None = None
    password: str | None = None
    database: str | None = None
    secure: bool | None = None


class ChxResolvedClickHouseConfig(_StrictModel):
    url: str
    username: str
    password: str
    database: str
    secure: bool


class ChxUserConfig(_StrictModel):
    schema_: str | list[str] = Field(..., alias="schema")
    out_dir: str | None = Field(default=None, alias="outDir")
    migrations_dir: str | None = Field(default=None, alias="migrationsDir")
    meta_dir: str | None = Field(default=None, alias="metaDir")
    plugins: list[Any] | None = None
    check: ChxCheckConfig | None = None
    safety: ChxSafetyConfig | None = None
    clickhouse: ChxUserClickHouseConfig | None = None

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class ChxResolvedConfig(_StrictModel):
    schema_: list[str]
    out_dir: str
    migrations_dir: str
    meta_dir: str
    check: ChxResolvedCheckConfig
    safety: ChxResolvedSafetyConfig
    clickhouse: ChxResolvedClickHouseConfig | None = None
    plugins: list[Any] = Field(default_factory=list)


class SnapshotV1(_StrictModel):
    version: Literal[1] = 1
    generated_at: str = Field(..., alias="generatedAt")
    definitions: list[SchemaDefinition]

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


Snapshot: TypeAlias = SnapshotV1


RiskLevel: TypeAlias = Literal["safe", "caution", "danger"]


MigrationOperationType: TypeAlias = Literal[
    "create_database",
    "create_table",
    "drop_table",
    "create_view",
    "drop_view",
    "create_materialized_view",
    "drop_materialized_view",
    "alter_materialized_view_modify_refresh",
    "alter_table_add_column",
    "alter_table_modify_column",
    "alter_table_drop_column",
    "alter_table_rename_column",
    "alter_table_rename_table",
    "alter_table_add_index",
    "alter_table_add_projection",
    "alter_table_modify_setting",
    "alter_table_drop_index",
    "alter_table_drop_projection",
    "alter_table_reset_setting",
    "alter_table_modify_ttl",
]


class MigrationOperation(_StrictModel):
    type: MigrationOperationType
    key: str
    risk: RiskLevel
    sql: str


class ColumnRenameSuggestion(_StrictModel):
    kind: Literal["column"] = "column"
    database: str
    table: str
    from_: str = Field(..., alias="from")
    to: str
    confidence: Literal["high"] = "high"
    reason: str
    drop_operation_key: str = Field(..., alias="dropOperationKey")
    add_operation_key: str = Field(..., alias="addOperationKey")
    confirmation_sql: str = Field(..., alias="confirmationSQL")

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


class _RiskSummary(_StrictModel):
    safe: int = 0
    caution: int = 0
    danger: int = 0


class MigrationPlan(_StrictModel):
    operations: list[MigrationOperation]
    risk_summary: _RiskSummary = Field(..., alias="riskSummary")
    rename_suggestions: list[ColumnRenameSuggestion] = Field(
        ..., alias="renameSuggestions"
    )

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        strict=True,
        validate_assignment=True,
        populate_by_name=True,
    )


ValidationIssueCode: TypeAlias = Literal[
    "duplicate_object_name",
    "duplicate_column_name",
    "duplicate_index_name",
    "duplicate_projection_name",
    "primary_key_missing_column",
    "order_by_missing_column",
    "refresh_requires_every_or_after",
    "refresh_every_after_mutually_exclusive",
    "refresh_interval_format",
    "refresh_append_required_for_replicated_target",
    "refresh_depends_on_requires_every",
    "codec_chain_must_end_with_general",
    "codec_chain_multiple_general",
    "codec_chain_empty",
]


SchemaKind: TypeAlias = Literal["table", "view", "materialized_view"]


class ValidationIssue(_StrictModel):
    code: ValidationIssueCode
    kind: SchemaKind
    database: str
    name: str
    message: str


class ChxValidationError(Exception):
    """Raised when a set of definitions fails validation."""

    def __init__(self, issues: list[ValidationIssue]) -> None:
        plural = "" if len(issues) == 1 else "s"
        super().__init__(
            f"Schema validation failed with {len(issues)} issue{plural}"
        )
        self.issues: list[ValidationIssue] = issues


# --- DSL constructors -------------------------------------------------------

# Inputs accepted by the public factories. Mirrors the TS shape: callers can
# pass either Pydantic instances OR plain dicts and we'll validate-on-the-way-in.
ColumnInput: TypeAlias = ColumnDefinition | dict[str, object]
SkipIndexInput: TypeAlias = SkipIndexDefinition | dict[str, object]
ProjectionInput: TypeAlias = ProjectionDefinition | dict[str, object]
TableRefInput: TypeAlias = TableRef | dict[str, object]
MaterializedViewRefreshInput: TypeAlias = MaterializedViewRefresh | dict[str, object]


def _strip_none(payload: dict[str, object]) -> dict[str, object]:
    return {k: v for k, v in payload.items() if v is not None}


def table(
    *,
    database: str,
    name: str,
    columns: list[ColumnInput],
    engine: str,
    primary_key: list[str] | None = None,
    order_by: list[str] | None = None,
    primaryKey: list[str] | None = None,  # noqa: N803 - 1:1 alias with TS API
    orderBy: list[str] | None = None,  # noqa: N803
    renamed_from: TableRenamedFrom | dict[str, object] | None = None,
    renamedFrom: TableRenamedFrom | dict[str, object] | None = None,  # noqa: N803
    unique_key: list[str] | None = None,
    uniqueKey: list[str] | None = None,  # noqa: N803
    partition_by: str | None = None,
    partitionBy: str | None = None,  # noqa: N803
    ttl: str | None = None,
    settings: dict[str, SettingValue] | None = None,
    indexes: list[SkipIndexInput] | None = None,
    projections: list[ProjectionInput] | None = None,
    comment: str | None = None,
) -> TableDefinition:
    pk = primary_key if primary_key is not None else primaryKey
    ob = order_by if order_by is not None else orderBy
    if pk is None or ob is None:
        msg = "table() requires primary_key/primaryKey and order_by/orderBy"
        raise ValueError(msg)

    payload: dict[str, object] = _strip_none(
        {
            "kind": "table",
            "database": database,
            "name": name,
            "renamedFrom": renamed_from if renamed_from is not None else renamedFrom,
            "columns": columns,
            "engine": engine,
            "primaryKey": pk,
            "orderBy": ob,
            "uniqueKey": unique_key if unique_key is not None else uniqueKey,
            "partitionBy": partition_by if partition_by is not None else partitionBy,
            "ttl": ttl,
            "settings": settings,
            "indexes": indexes,
            "projections": projections,
            "comment": comment,
        }
    )
    return TableDefinition.model_validate(payload)


def view(
    *,
    database: str,
    name: str,
    as_: str | None = None,
    comment: str | None = None,
    **extra: object,
) -> ViewDefinition:
    body = as_ if as_ is not None else extra.pop("as", None)
    if body is None:
        msg = "view() requires `as_` (or `as=`)"
        raise ValueError(msg)
    payload: dict[str, object] = _strip_none(
        {
            "kind": "view",
            "database": database,
            "name": name,
            "as": body,
            "comment": comment,
        }
    )
    return ViewDefinition.model_validate(payload)


def materialized_view(
    *,
    database: str,
    name: str,
    to: TableRefInput,
    as_: str | None = None,
    refresh: MaterializedViewRefreshInput | None = None,
    comment: str | None = None,
    **extra: object,
) -> MaterializedViewDefinition:
    body = as_ if as_ is not None else extra.pop("as", None)
    if body is None:
        msg = "materialized_view() requires `as_` (or `as=`)"
        raise ValueError(msg)
    payload: dict[str, object] = _strip_none(
        {
            "kind": "materialized_view",
            "database": database,
            "name": name,
            "to": to,
            "as": body,
            "refresh": refresh,
            "comment": comment,
        }
    )
    return MaterializedViewDefinition.model_validate(payload)


def schema(*definitions: TableDefinition | ViewDefinition | MaterializedViewDefinition) -> list[TableDefinition | ViewDefinition | MaterializedViewDefinition]:
    return list(definitions)


def is_schema_definition(value: object) -> bool:
    return isinstance(value, TableDefinition | ViewDefinition | MaterializedViewDefinition)


def collect_definitions_from_module(
    mod: dict[str, object],
) -> list[SchemaDefinition]:
    """Walk module values, collect SchemaDefinition instances, deduplicate via canonicalization."""
    from chkit.core.canonical import canonicalize_definitions

    out: list[SchemaDefinition] = []

    def walk(value: object) -> None:
        if value is None:
            return
        if isinstance(value, list | tuple):
            for entry in value:
                walk(entry)
            return
        if is_schema_definition(value):
            out.append(value)  # type: ignore[arg-type]

    for value in mod.values():
        walk(value)

    return canonicalize_definitions(out)


def define_config(config: ChxUserConfig | dict[str, object]) -> ChxUserConfig:
    """Identity helper that anchors a config object at the call site.

    Mirrors the TypeScript ``defineConfig`` API: accepts either a fully
    constructed ``ChxUserConfig`` model or a plain dict (validated through
    Pydantic on entry). Returns the resulting model — same value you'd
    obtain from ``ChxUserConfig.model_validate`` but with a name that
    documents intent in the user's config file.
    """
    if isinstance(config, ChxUserConfig):
        return config
    return ChxUserConfig.model_validate(config)


def resolve_config(config: ChxUserConfig) -> ChxResolvedConfig:
    out_dir = config.out_dir if config.out_dir is not None else "./chkit"
    migrations_dir = (
        config.migrations_dir
        if config.migrations_dir is not None
        else os.path.join(out_dir, "migrations")
    )
    meta_dir = (
        config.meta_dir if config.meta_dir is not None else os.path.join(out_dir, "meta")
    )

    schema_value = config.schema_
    schema_list: list[str] = (
        list(schema_value) if isinstance(schema_value, list) else [schema_value]
    )

    check = config.check
    safety = config.safety
    resolved_check = ChxResolvedCheckConfig(
        fail_on_pending=True if check is None or check.fail_on_pending is None else check.fail_on_pending,
        fail_on_checksum_mismatch=True
        if check is None or check.fail_on_checksum_mismatch is None
        else check.fail_on_checksum_mismatch,
        fail_on_drift=True if check is None or check.fail_on_drift is None else check.fail_on_drift,
    )
    resolved_safety = ChxResolvedSafetyConfig(
        allow_destructive=False
        if safety is None or safety.allow_destructive is None
        else safety.allow_destructive,
    )

    resolved_clickhouse: ChxResolvedClickHouseConfig | None = None
    if config.clickhouse is not None:
        ch = config.clickhouse
        resolved_clickhouse = ChxResolvedClickHouseConfig(
            url=ch.url,
            username=ch.username if ch.username is not None else "default",
            password=ch.password if ch.password is not None else "",
            database=ch.database if ch.database is not None else "default",
            secure=ch.secure if ch.secure is not None else False,
        )

    return ChxResolvedConfig(
        schema_=schema_list,
        out_dir=out_dir,
        migrations_dir=migrations_dir,
        meta_dir=meta_dir,
        check=resolved_check,
        safety=resolved_safety,
        clickhouse=resolved_clickhouse,
        plugins=list(config.plugins) if config.plugins is not None else [],
    )


# Used by canonical.py to keep dataclass-like helpers in one place.
@dataclass(frozen=True, config=ConfigDict(extra="forbid", strict=True))
class _DefinitionKey:
    kind: SchemaKind
    database: str
    name: str

    def render(self) -> str:
        return f"{self.kind}:{self.database}.{self.name}"
