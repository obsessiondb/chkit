"""chkit_plugin_codegen — generate Pydantic models from chkit schema definitions.

Python-port of ``packages/plugin-codegen``. The TS plugin emits a TypeScript
``.ts`` file with row interfaces (+ optional Zod schemas). Python doesn't have
the same TS-vs-Zod split: Pydantic models cover both static typing and runtime
validation in one shape. So this port emits a single ``.py`` module containing
one Pydantic model per table.

The plugin keeps the same surface as the TS one:

- ``codegen({...})`` — plugin factory you add to ``config.plugins``.
- ``chkit plugin codegen [--check] [--out-file …] [--bigint-mode …]`` —
  CLI command.
- ``on_check`` hook — wired through the standard chkit ``check`` command so
  CI fails when generated files are stale.

See ``DRIFT.md`` (Phase 5 entry) for what's intentionally not ported (Zod,
ingest helpers, migration module emitter).
"""

from __future__ import annotations

from chkit_plugin_codegen.errors import (
    CodegenConfigError,
    CodegenError,
    UnsupportedTypeError,
)
from chkit_plugin_codegen.options import (
    CODEGEN_FLAG_MAP,
    CODEGEN_FLAGS,
    CodegenOptions,
    PluginConfig,
    normalize_codegen_options,
)
from chkit_plugin_codegen.plugin import codegen, create_codegen_plugin
from chkit_plugin_codegen.type_artifacts import (
    GenerateTypeArtifactsOutput,
    MapColumnTypeResult,
    generate_type_artifacts,
    map_column_type,
)
from chkit_plugin_codegen.types import (
    CodegenFinding,
    CodegenFindingCode,
    ResolvedTableName,
)

__all__ = [
    "CODEGEN_FLAGS",
    "CODEGEN_FLAG_MAP",
    "CodegenConfigError",
    "CodegenError",
    "CodegenFinding",
    "CodegenFindingCode",
    "CodegenOptions",
    "GenerateTypeArtifactsOutput",
    "MapColumnTypeResult",
    "PluginConfig",
    "ResolvedTableName",
    "UnsupportedTypeError",
    "codegen",
    "create_codegen_plugin",
    "generate_type_artifacts",
    "map_column_type",
    "normalize_codegen_options",
]
