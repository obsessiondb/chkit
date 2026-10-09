"""Discover and load user schema modules into a list of definitions.

Thin CLI-layer wrapper around ``chkit.core.schema_loader.load_schema_definitions``,
plus :func:`load_schema_definitions_with_hooks`, the plugin-hook pipeline
``chkit generate`` and ``chkit snapshot rebuild`` share (TS
``runtime/schema-loader.ts``).
"""

from __future__ import annotations

from typing import Any

from chkit.cli.plugin_runtime import PluginRuntime
from chkit.cli.table_scope import TableScope
from chkit.core.canonical import canonicalize_definitions
from chkit.core.model import ChxResolvedConfig, SchemaDefinition
from chkit.core.schema_loader import load_schema_definitions
from chkit.plugins import ChxOnConfigLoadedContext, ChxOnSchemaLoadedContext


def load_schema(patterns: list[str]) -> list[SchemaDefinition]:
    """Walk schema modules and collect exported ``SchemaDefinition`` objects."""
    return load_schema_definitions(patterns)


def load_schema_definitions_with_hooks(
    *,
    command: str,
    config: ChxResolvedConfig,
    config_path: str,
    flags: dict[str, Any],
    json_mode: bool,
    plugin_runtime: PluginRuntime,
) -> list[SchemaDefinition]:
    """Load schema definitions the way ``chkit generate`` does.

    Runs the ``on_config_loaded`` hooks, loads the schema files, then the
    ``on_schema_loaded`` hooks (which may rewrite definitions, e.g. the
    ObsessionDB plugin strips storage_policy for a non-ObsessionDB target).
    ``chkit snapshot rebuild`` uses the same pipeline so it writes exactly the
    snapshot ``generate`` would. The returned list is the hook output, not yet
    re-canonicalized.
    """
    plugin_runtime.run_on_config_loaded(
        ChxOnConfigLoadedContext(
            command=command,
            config=config,
            table_scope=TableScope(enabled=False),
            flags=flags,
            config_path=config_path,
            options={},
        )
    )

    definitions = canonicalize_definitions(load_schema(config.schema_))
    return list(
        plugin_runtime.run_on_schema_loaded(
            ChxOnSchemaLoadedContext(
                command=command,
                config=config,
                table_scope=TableScope(enabled=False),
                flags=flags,
                definitions=list(definitions),
                json_mode=json_mode,
            )
        )
    )
