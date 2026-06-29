"""Plugin runtime: load, dispatch, and run hooks across registered plugins.

Pragmatic Python port of ``packages/cli/src/runtime/plugin-runtime/``.

The runtime is constructed once per CLI invocation from
``config.plugins``. It:

- Validates every plugin (manifest shape, CLI version compatibility).
- Exposes ``run_on_*`` methods for each of the 10 lifecycle hooks.
- Threads transformations (definitions, plan, statements) through the
  full plugin chain, in registration order.
- Provides ``run_plugin_command(plugin, command, ctx)`` for
  ``chkit plugin <name> <command>`` dispatch.

Differences from TS that aren't bugs (documented in DRIFT.md):

- Hooks are synchronous (plugins running async work wrap themselves in
  ``asyncio.run``).
- ``getContext`` hook is a callable on the plugin; we don't define a
  separate "context provider" abstraction.
- Validation of plugin ``options`` uses Pydantic if the plugin author
  provides a model, otherwise the raw dict passes through.
"""

from __future__ import annotations

import contextlib
from collections.abc import Sequence
from dataclasses import asdict
from typing import Any

from chkit import __version__
from chkit.plugins import (
    ChxOnAfterApplyContext,
    ChxOnBeforeApplyContext,
    ChxOnBeforePluginCommandContext,
    ChxOnBeforePluginCommandHandled,
    ChxOnBeforePluginCommandResult,
    ChxOnBeforePluginCommandUnhandled,
    ChxOnCheckContext,
    ChxOnCheckReportContext,
    ChxOnCheckResult,
    ChxOnCompleteContext,
    ChxOnConfigLoadedContext,
    ChxOnInitContext,
    ChxOnPlanCreatedContext,
    ChxOnPullIntrospectContext,
    ChxOnSchemaLoadedContext,
    ChxPlugin,
    ChxPluginCommand,
    ChxPluginCommandContext,
    LoadedPlugin,
    PluginContext,
)


class PluginValidationError(RuntimeError):
    """Raised when a plugin's manifest is malformed or CLI-incompatible."""


class PluginExecutionError(RuntimeError):
    """Wraps an exception raised by a third-party plugin hook / command."""

    def __init__(self, plugin_name: str, stage: str, cause: BaseException) -> None:
        super().__init__(f'Plugin "{plugin_name}" failed in {stage}: {cause}')
        self.plugin_name = plugin_name
        self.stage = stage
        self.cause = cause


def _get_hook(plugin: ChxPlugin, name: str) -> Any | None:
    """Return ``plugin.hooks.<name>`` if defined, else None."""
    hooks = plugin.hooks
    if hooks is None:
        return None
    candidate = getattr(hooks, name, None)
    if callable(candidate):
        return candidate
    return None


def _validate_plugin(loaded: LoadedPlugin) -> None:
    plugin = loaded.plugin
    if not plugin.manifest.name:
        msg = "Plugin manifest is missing a `name`."
        raise PluginValidationError(msg)
    # api_version is typed as Literal[1]; if a future TS plugin ships a
    # different version it would fail at construction, so no runtime check
    # is needed here.
    compat = plugin.manifest.compatibility
    if compat is not None and compat.cli is not None:
        try:
            major = int(__version__.split(".", 1)[0])
        except (ValueError, IndexError):
            major = 0
        min_major = compat.cli.min_major
        max_major = compat.cli.max_major
        if min_major is not None and major < min_major:
            msg = (
                f'Plugin "{plugin.manifest.name}" requires chkit CLI major '
                f">= {min_major} (this CLI is {__version__})."
            )
            raise PluginValidationError(msg)
        if max_major is not None and major > max_major:
            msg = (
                f'Plugin "{plugin.manifest.name}" requires chkit CLI major '
                f"<= {max_major} (this CLI is {__version__})."
            )
            raise PluginValidationError(msg)


class PluginRuntime:
    """Holds the loaded plugins and runs hooks / commands across them."""

    __slots__ = ("_plugins",)

    def __init__(self, plugins: Sequence[LoadedPlugin]) -> None:
        self._plugins: tuple[LoadedPlugin, ...] = tuple(plugins)
        seen: set[str] = set()
        for entry in self._plugins:
            _validate_plugin(entry)
            name = entry.plugin.manifest.name
            if name in seen:
                msg = (
                    f'Plugin "{name}" is registered more than once. '
                    "Remove the duplicate registration."
                )
                raise PluginValidationError(msg)
            seen.add(name)

    @property
    def plugins(self) -> Sequence[LoadedPlugin]:
        return self._plugins

    def get_command(
        self, plugin_name: str, command_name: str
    ) -> tuple[ChxPluginCommand, LoadedPlugin] | None:
        for entry in self._plugins:
            if entry.plugin.manifest.name != plugin_name:
                continue
            for command in entry.plugin.commands or []:
                if command.name == command_name:
                    return command, entry
        return None

    # ---------- single-fire lifecycle ----------

    def run_on_init(self, context: ChxOnInitContext) -> None:
        for entry in self._plugins:
            hook = _get_hook(entry.plugin, "on_init")
            if hook is None:
                continue
            self._call_hook(entry, "onInit", hook, context)

    def run_on_complete(self, context: ChxOnCompleteContext) -> None:
        for entry in self._plugins:
            hook = _get_hook(entry.plugin, "on_complete")
            if hook is None:
                continue
            self._call_hook(entry, "onComplete", hook, context)

    # ---------- threading hooks ----------

    def run_on_config_loaded(self, context: ChxOnConfigLoadedContext) -> None:
        for entry in self._plugins:
            hook = _get_hook(entry.plugin, "on_config_loaded")
            if hook is None:
                continue
            self._call_hook(entry, "onConfigLoaded", hook, context)

    def run_on_schema_loaded(
        self, context: ChxOnSchemaLoadedContext
    ) -> Sequence[Any]:
        """Each plugin sees the definitions threaded by the previous one."""
        definitions = list(context.definitions)
        for entry in self._plugins:
            hook = _get_hook(entry.plugin, "on_schema_loaded")
            if hook is None:
                continue
            updated_ctx = ChxOnSchemaLoadedContext(
                command=context.command,
                config=context.config,
                table_scope=context.table_scope,
                flags=context.flags,
                definitions=definitions,
                json_mode=context.json_mode,
            )
            result = self._call_hook(
                entry, "onSchemaLoaded", hook, updated_ctx
            )
            if result is not None:
                definitions = list(result)
        return definitions

    def run_on_plan_created(self, context: ChxOnPlanCreatedContext) -> Any:
        plan = context.plan
        for entry in self._plugins:
            hook = _get_hook(entry.plugin, "on_plan_created")
            if hook is None:
                continue
            updated_ctx = ChxOnPlanCreatedContext(
                command=context.command,
                config=context.config,
                table_scope=context.table_scope,
                flags=context.flags,
                plan=plan,
            )
            result = self._call_hook(entry, "onPlanCreated", hook, updated_ctx)
            if result is not None:
                plan = result
        return plan

    def run_on_before_apply(self, context: ChxOnBeforeApplyContext) -> list[str]:
        statements = list(context.statements)
        for entry in self._plugins:
            hook = _get_hook(entry.plugin, "on_before_apply")
            if hook is None:
                continue
            updated_ctx = ChxOnBeforeApplyContext(
                command=context.command,
                config=context.config,
                table_scope=context.table_scope,
                flags=context.flags,
                migration=context.migration,
                sql=context.sql,
                statements=statements,
            )
            result = self._call_hook(entry, "onBeforeApply", hook, updated_ctx)
            if isinstance(result, dict) and "statements" in result:
                statements = list(result["statements"])
        return statements

    def run_on_after_apply(self, context: ChxOnAfterApplyContext) -> None:
        for entry in self._plugins:
            hook = _get_hook(entry.plugin, "on_after_apply")
            if hook is None:
                continue
            self._call_hook(entry, "onAfterApply", hook, context)

    def run_on_check(
        self, context: ChxOnCheckContext
    ) -> list[ChxOnCheckResult]:
        results: list[ChxOnCheckResult] = []
        for entry in self._plugins:
            hook = _get_hook(entry.plugin, "on_check")
            if hook is None:
                continue
            result = self._call_hook(entry, "onCheck", hook, context)
            if isinstance(result, ChxOnCheckResult):
                results.append(result)
        return results

    def run_on_check_report(
        self,
        results: Sequence[ChxOnCheckResult],
        print_fn: Any,
    ) -> None:
        for result in results:
            entry = next(
                (
                    e
                    for e in self._plugins
                    if e.plugin.manifest.name == result.plugin
                ),
                None,
            )
            if entry is None:
                continue
            hook = _get_hook(entry.plugin, "on_check_report")
            if hook is None:
                continue
            self._call_hook(
                entry,
                "onCheckReport",
                hook,
                ChxOnCheckReportContext(result=result, print=print_fn),
            )

    def resolve_context(self, context_input: Any) -> PluginContext | None:
        """Mirror of TS ``runtime.resolveContext``: try each plugin's
        ``get_context`` hook in order; return the first non-None
        :class:`PluginContext`. Plugins return ``None`` to defer to the next.

        Used by ``chkit plugin <name> <command>`` and other commands that want
        plugin-provided executors (e.g. ObsessionDB's remote executor when a
        service is selected).
        """
        for entry in self._plugins:
            hook = _get_hook(entry.plugin, "get_context")
            if hook is None:
                continue
            result = self._call_hook(entry, "getContext", hook, context_input)
            if isinstance(result, PluginContext):
                return result
        return None

    def dispose_context(self, ctx: PluginContext) -> None:
        """Mirror of TS ``runtime.disposeContext``: best-effort close on the
        executor. No-op when there's nothing to close.
        """
        executor = ctx.executor
        close = getattr(executor, "close", None)
        if callable(close):
            # Disposal is best-effort; never let a close error break a CLI exit.
            with contextlib.suppress(Exception):
                close()

    def run_on_pull_introspect(
        self, context: ChxOnPullIntrospectContext
    ) -> list[Any] | None:
        """Return the first non-None list returned by an ``on_pull_introspect`` hook.

        Mirrors the TS ``PullIntrospector`` registration: when any plugin
        wants to bypass SQL-based pull (e.g. the obsessiondb plugin querying
        its metadata API), it returns a list of ``SchemaDefinition``. Returning
        ``None`` defers to the next plugin / the default path.
        """
        for entry in self._plugins:
            hook = _get_hook(entry.plugin, "on_pull_introspect")
            if hook is None:
                continue
            result = self._call_hook(
                entry, "onPullIntrospect", hook, context
            )
            if result is not None:
                return list(result)
        return None

    def run_on_before_plugin_command(
        self,
        _plugin_name: str,
        _command_name: str,
        context: ChxOnBeforePluginCommandContext,
    ) -> ChxOnBeforePluginCommandResult:
        for entry in self._plugins:
            hook = _get_hook(entry.plugin, "on_before_plugin_command")
            if hook is None:
                continue
            result = self._call_hook(
                entry, "onBeforePluginCommand", hook, context
            )
            if isinstance(result, ChxOnBeforePluginCommandHandled):
                return result
        return ChxOnBeforePluginCommandUnhandled()

    # ---------- command dispatch ----------

    def run_plugin_command(
        self,
        plugin_name: str,
        command_name: str,
        context: ChxPluginCommandContext,
    ) -> int:
        found = self.get_command(plugin_name, command_name)
        if found is None:
            msg = f'Plugin "{plugin_name}" has no command "{command_name}".'
            raise PluginValidationError(msg)
        command, entry = found

        # Mirror TS runPluginCommand: dispatch on_before_plugin_command first; if
        # any plugin returns Handled, short-circuit with its exit_code (this is
        # what obsessiondb uses to route backfill status/cancel/list to the
        # jobs API before the local backfill plugin's stub commands run).
        before_result = self.run_on_before_plugin_command(
            plugin_name,
            command_name,
            ChxOnBeforePluginCommandContext(
                target_plugin=plugin_name,
                command=command_name,
                config=context.config,
                config_path=context.config_path,
                json_mode=context.json_mode,
                args=list(context.args),
                flags=dict(context.flags),
                options=dict(context.options),
                table_scope=context.table_scope,
                print=context.print,
            ),
        )
        if isinstance(before_result, ChxOnBeforePluginCommandHandled):
            return before_result.exit_code

        try:
            result = command.run(context)
        except Exception as cause:
            if entry.internal:
                raise
            raise PluginExecutionError(plugin_name, "command", cause) from cause
        return 0 if result is None else int(result)

    # ---------- helpers ----------

    def _call_hook(
        self,
        entry: LoadedPlugin,
        stage: str,
        hook: Any,
        context: Any,
    ) -> Any:
        try:
            return hook(context)
        except Exception as cause:
            if entry.internal:
                raise
            raise PluginExecutionError(
                entry.plugin.manifest.name, stage, cause
            ) from cause


def load_plugin_runtime(
    plugin_entries: Sequence[ChxPlugin],
) -> PluginRuntime:
    """Bootstrap a runtime from a list of plugin objects (deduplicates by name)."""
    loaded = [
        LoadedPlugin(plugin=plugin, options={}, raw_options={})
        for plugin in plugin_entries
    ]
    return PluginRuntime(loaded)


def null_plugin_context() -> PluginContext:
    """Returned when no clickhouse executor is configured."""
    return PluginContext(executor=None, has_executor=False)


def make_plugin_context(executor: Any) -> PluginContext:
    """Wrap a ClickHouseClient (or compatible) into a PluginContext."""
    return PluginContext(executor=executor, has_executor=True)


__all__ = [
    "PluginExecutionError",
    "PluginRuntime",
    "PluginValidationError",
    "asdict",  # re-exported so plugins can serialise their hook context easily
    "load_plugin_runtime",
    "make_plugin_context",
    "null_plugin_context",
]
