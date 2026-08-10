"""Public plugin contracts for chkit-py.

1:1 port of ``packages/cli/src/plugins.ts`` — every plugin type, hook
context, command shape, and runtime interface a third-party plugin
needs to register itself.

Plugins are registered in the user's ``clickhouse.config.py`` via the
``plugins`` list. Each entry is a ``ChxPlugin`` (or a callable that
returns one for parameterised registration).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from chkit.cli.table_scope import TableScope
from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import (
    ChxResolvedConfig,
    MigrationPlan,
    SchemaDefinition,
)

# ---------- manifest + plugin shape ----------


@dataclass(frozen=True, slots=True)
class ChxPluginManifestCompatibilityCli:
    min_major: int | None = None
    max_major: int | None = None


@dataclass(frozen=True, slots=True)
class ChxPluginManifestCompatibility:
    cli: ChxPluginManifestCompatibilityCli | None = None


@dataclass(frozen=True, slots=True)
class ChxPluginManifest:
    name: str
    api_version: Literal[1] = 1
    version: str | None = None
    compatibility: ChxPluginManifestCompatibility | None = None


# ---------- hook contexts ----------


@dataclass(frozen=True, slots=True)
class ChxPluginHookContextBase:
    command: str
    config: ChxResolvedConfig
    table_scope: TableScope
    flags: dict[str, str | int | float | bool | list[str] | None]


@dataclass(frozen=True, slots=True)
class ChxOnInitContext:
    command: str
    config_path: str
    is_interactive: bool
    json_mode: bool
    flags: dict[str, Any]
    config: ChxResolvedConfig
    options: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ChxOnCompleteContext:
    command: str
    is_interactive: bool
    json_mode: bool
    exit_code: int
    options: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ChxOnConfigLoadedContext(ChxPluginHookContextBase):
    config_path: str = ""
    options: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ChxOnSchemaLoadedContext(ChxPluginHookContextBase):
    definitions: Sequence[SchemaDefinition] = ()
    json_mode: bool = False


@dataclass(frozen=True, slots=True)
class ChxOnPlanCreatedContext(ChxPluginHookContextBase):
    plan: MigrationPlan | None = None


@dataclass(frozen=True, slots=True)
class ChxOnBeforeApplyContext(ChxPluginHookContextBase):
    migration: str = ""
    sql: str = ""
    statements: Sequence[str] = ()


@dataclass(frozen=True, slots=True)
class ChxOnPullIntrospectContext(ChxPluginHookContextBase):
    """Context for the ``on_pull_introspect`` hook.

    Plugins implementing this hook may return a list of ``SchemaDefinition``
    objects to bypass the SQL-based pull and inject definitions sourced from
    elsewhere (e.g. an ObsessionDB metadata API). Returning ``None`` defers
    to the default SQL introspection path.
    """

    clickhouse: Any = None
    """The resolved ``ChxResolvedClickHouseConfig`` (or compatible object)."""
    databases: Sequence[str] = ()
    """The (sorted, deduplicated) databases requested via ``--database``."""


@dataclass(frozen=True, slots=True)
class ChxOnAfterApplyContext(ChxPluginHookContextBase):
    migration: str = ""
    statements: Sequence[str] = ()
    applied_at: str = ""


@dataclass(frozen=True, slots=True)
class ChxCheckFinding:
    code: str
    message: str
    severity: Literal["info", "warn", "error"]
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class ChxOnCheckContext(ChxPluginHookContextBase):
    config_path: str = ""
    json_mode: bool = False
    options: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ChxOnCheckResult:
    plugin: str
    evaluated: bool
    ok: bool
    findings: list[ChxCheckFinding] = field(default_factory=list)
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class ChxOnCheckReportContext:
    result: ChxOnCheckResult
    print: Callable[[str], None]


@dataclass(frozen=True, slots=True)
class ChxOnBeforePluginCommandContext:
    target_plugin: str
    command: str
    config: ChxResolvedConfig
    config_path: str
    json_mode: bool
    args: list[str]
    flags: dict[str, Any]
    options: dict[str, Any]
    table_scope: TableScope
    print: Callable[[Any], None]


@dataclass(frozen=True, slots=True)
class ChxOnBeforePluginCommandHandled:
    exit_code: int
    handled: Literal[True] = True


@dataclass(frozen=True, slots=True)
class ChxOnBeforePluginCommandUnhandled:
    handled: Literal[False] = False


ChxOnBeforePluginCommandResult = (
    ChxOnBeforePluginCommandHandled | ChxOnBeforePluginCommandUnhandled
)


# ---------- plugin context (executor) ----------


@dataclass(frozen=True, slots=True)
class PluginContext:
    """The runtime context handed to a plugin command's `run` method."""

    executor: ClickHouseClient | None
    has_executor: bool


@dataclass(frozen=True, slots=True)
class ChxGetContextInput:
    config: ChxResolvedConfig
    config_path: str
    command: str
    flags: dict[str, Any]
    defaults: PluginContext


# ---------- plugin commands ----------


@dataclass(frozen=True, slots=True)
class ChxPluginCommandContext:
    plugin_name: str
    config: ChxResolvedConfig
    config_path: str
    json_mode: bool
    args: list[str]
    flags: dict[str, Any]
    options: dict[str, Any]
    raw_options: dict[str, Any]
    table_scope: TableScope
    print: Callable[[Any], None]
    plugin_runtime: PluginRuntimeProtocol
    plugin_context: PluginContext


@dataclass(frozen=True, slots=True)
class ChxPluginCommand:
    name: str
    run: Callable[[ChxPluginCommandContext], int | None]
    description: str | None = None
    flags: list[dict[str, Any]] | None = None


# ---------- plugin hooks (Protocol-based, optional methods) ----------


class ChxPluginHooks(Protocol):
    """Optional methods a plugin can implement.

    Implementations attach the hook methods they want — missing methods
    are simply skipped by the runtime. Use ``@dataclass`` or a plain
    class; the runtime checks ``hasattr`` rather than requiring
    inheritance.
    """

    # All hooks are optional. A plugin without any hook still works as a
    # command-only plugin (see ``ChxPlugin.commands``).


@dataclass(slots=True)
class ChxPlugin:
    """Top-level plugin object: manifest + optional hooks + commands."""

    manifest: ChxPluginManifest
    hooks: Any = None  # any object with the relevant `on_*` methods
    commands: list[ChxPluginCommand] | None = None
    options_schema: Any = None
    extend_commands: list[dict[str, Any]] | None = None


@dataclass(slots=True)
class LoadedPlugin:
    """A plugin that has been validated and is ready to run."""

    plugin: ChxPlugin
    options: dict[str, Any]
    raw_options: dict[str, Any]
    internal: bool = False


# ---------- runtime protocol ----------


class PluginRuntimeProtocol(Protocol):
    """Subset of the runtime exposed to plugin command implementations."""

    @property
    def plugins(self) -> Sequence[LoadedPlugin]: ...

    def get_command(
        self, plugin_name: str, command_name: str
    ) -> tuple[ChxPluginCommand, LoadedPlugin] | None: ...


def define_plugin(plugin: ChxPlugin) -> ChxPlugin:
    """Identity-typed helper for plugin authors (matches TS `definePlugin`)."""
    return plugin
