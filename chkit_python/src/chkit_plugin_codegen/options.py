"""Codegen plugin options (Pydantic-validated) + CLI flag definitions."""

from __future__ import annotations

from typing import Any, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from chkit_plugin_codegen.errors import CodegenConfigError

TableNameStyle: TypeAlias = Literal["pascal", "camel", "raw"]
BigIntMode: TypeAlias = Literal["str", "int"]

# TS uses ``'string' | 'bigint'``; Python uses ``'str' | 'int'`` (Python's int
# is unbounded so it's a strict superset of TS bigint — no precision loss).
# Accept the TS spellings for cross-language config portability and normalize
# to the Python form.
_BIGINT_TS_ALIASES: dict[str, BigIntMode] = {
    "string": "str",
    "bigint": "int",
}


class CodegenOptions(BaseModel):
    """Fully-resolved options used by the generator (all defaults filled in)."""

    out_file: str = Field(default="./src/generated/chkit_models.py", alias="outFile")
    table_name_style: TableNameStyle = Field(default="pascal", alias="tableNameStyle")
    bigint_mode: BigIntMode = Field(default="int", alias="bigintMode")
    include_views: bool = Field(default=False, alias="includeViews")
    run_on_generate: bool = Field(default=True, alias="runOnGenerate")
    fail_on_unsupported_type: bool = Field(
        default=True, alias="failOnUnsupportedType"
    )

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        populate_by_name=True,
    )

    @field_validator("bigint_mode", mode="before")
    @classmethod
    def _coerce_bigint_mode(cls, value: object) -> object:
        if isinstance(value, str) and value in _BIGINT_TS_ALIASES:
            return _BIGINT_TS_ALIASES[value]
        return value


class PluginConfig(BaseModel):
    """User-supplied options to ``codegen({...})``. All fields are optional."""

    out_file: str | None = Field(default=None, alias="outFile")
    table_name_style: TableNameStyle | None = Field(default=None, alias="tableNameStyle")
    bigint_mode: BigIntMode | None = Field(default=None, alias="bigintMode")
    include_views: bool | None = Field(default=None, alias="includeViews")
    run_on_generate: bool | None = Field(default=None, alias="runOnGenerate")
    fail_on_unsupported_type: bool | None = Field(
        default=None, alias="failOnUnsupportedType"
    )

    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        populate_by_name=True,
    )

    @field_validator("bigint_mode", mode="before")
    @classmethod
    def _coerce_bigint_mode(cls, value: object) -> object:
        if isinstance(value, str) and value in _BIGINT_TS_ALIASES:
            return _BIGINT_TS_ALIASES[value]
        return value


def normalize_codegen_options(
    options: PluginConfig | CodegenOptions | dict[str, Any] | None,
) -> CodegenOptions:
    """Fill in defaults for any missing fields and return a fully-resolved ``CodegenOptions``."""
    if options is None:
        return CodegenOptions()
    if isinstance(options, CodegenOptions):
        return options
    if isinstance(options, PluginConfig):
        payload = options.model_dump(exclude_none=True, by_alias=False)
    else:
        try:
            payload = PluginConfig.model_validate(options).model_dump(
                exclude_none=True, by_alias=False
            )
        except ValidationError as error:
            raise CodegenConfigError(str(error)) from error
    try:
        return CodegenOptions.model_validate(payload)
    except ValidationError as error:
        raise CodegenConfigError(str(error)) from error


# CLI flag definitions — mirror the TS ``defineFlags`` shape, just as dicts so
# the existing plugin runtime can introspect them.
CODEGEN_FLAGS: list[dict[str, Any]] = [
    {
        "name": "--check",
        "type": "boolean",
        "description": "Check if generated output is up-to-date",
    },
    {
        "name": "--out-file",
        "type": "string",
        "description": "Output file path",
        "placeholder": "<path>",
    },
    {
        "name": "--bigint-mode",
        "type": "string",
        "description": "How to represent 64-bit integers (int or str)",
        "placeholder": "<mode>",
    },
    {
        "name": "--include-views",
        "type": "boolean",
        "description": "Include views in generated output",
    },
    {
        "name": "--table-name-style",
        "type": "string",
        "description": "Class naming convention (pascal / camel / raw)",
        "placeholder": "<style>",
    },
]

# Flag → CodegenOptions field mapping (used by the runtime when promoting flags
# into the ``options`` dict).
CODEGEN_FLAG_MAP: dict[str, dict[str, str]] = {
    "--out-file": {"key": "out_file"},
    "--bigint-mode": {"key": "bigint_mode"},
    "--include-views": {"key": "include_views"},
    "--table-name-style": {"key": "table_name_style"},
}


__all__ = [
    "CODEGEN_FLAGS",
    "CODEGEN_FLAG_MAP",
    "BigIntMode",
    "CodegenOptions",
    "PluginConfig",
    "TableNameStyle",
    "normalize_codegen_options",
]
