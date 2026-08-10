"""Tests for `chkit.cli.plugin_runtime` — load, hooks, dispatch, errors."""

from __future__ import annotations

from typing import Any

import pytest

from chkit import ColumnDefinition, table
from chkit.cli.plugin_runtime import (
    PluginExecutionError,
    PluginRuntime,
    PluginValidationError,
    load_plugin_runtime,
    null_plugin_context,
)
from chkit.cli.table_scope import TableScope
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit.plugins import (
    ChxOnBeforePluginCommandContext,
    ChxOnBeforePluginCommandHandled,
    ChxOnCheckContext,
    ChxOnCheckResult,
    ChxOnCompleteContext,
    ChxOnInitContext,
    ChxOnSchemaLoadedContext,
    ChxPlugin,
    ChxPluginCommand,
    ChxPluginCommandContext,
    ChxPluginManifest,
    LoadedPlugin,
)


def _config() -> ChxResolvedConfig:
    return ChxResolvedConfig(
        schema_=["./schema.py"],
        out_dir="./chkit",
        migrations_dir="./chkit/migrations",
        meta_dir="./chkit/meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False,
            fail_on_checksum_mismatch=True,
            fail_on_drift=False,
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )


def _scope() -> TableScope:
    return TableScope(enabled=False)


def _plugin(
    name: str,
    *,
    hooks: object | None = None,
    commands: list[ChxPluginCommand] | None = None,
) -> ChxPlugin:
    return ChxPlugin(
        manifest=ChxPluginManifest(name=name),
        hooks=hooks,
        commands=commands,
    )


# ---------- validation ----------


def test_load_rejects_empty_plugin_name() -> None:
    bad = ChxPlugin(manifest=ChxPluginManifest(name=""))
    with pytest.raises(PluginValidationError, match="missing a `name`"):
        load_plugin_runtime([bad])


def test_load_rejects_duplicate_plugin_names() -> None:
    a = _plugin("alpha")
    b = _plugin("alpha")
    with pytest.raises(PluginValidationError, match="registered more than once"):
        load_plugin_runtime([a, b])


def test_load_accepts_valid_plugins() -> None:
    runtime = load_plugin_runtime([_plugin("alpha"), _plugin("beta")])
    assert [e.plugin.manifest.name for e in runtime.plugins] == ["alpha", "beta"]


# ---------- on_init / on_complete ----------


class _RecordingHooks:
    def __init__(self) -> None:
        self.events: list[str] = []

    def on_init(self, ctx: ChxOnInitContext) -> None:
        self.events.append(f"init:{ctx.command}")

    def on_complete(self, ctx: ChxOnCompleteContext) -> None:
        self.events.append(f"complete:{ctx.command}:{ctx.exit_code}")


def test_on_init_dispatches_to_each_plugin() -> None:
    hooks_a = _RecordingHooks()
    hooks_b = _RecordingHooks()
    runtime = load_plugin_runtime(
        [_plugin("a", hooks=hooks_a), _plugin("b", hooks=hooks_b)]
    )
    runtime.run_on_init(
        ChxOnInitContext(
            command="generate",
            config_path="cfg.py",
            is_interactive=True,
            json_mode=False,
            flags={},
            config=_config(),
            options={},
        )
    )
    assert hooks_a.events == ["init:generate"]
    assert hooks_b.events == ["init:generate"]


def test_on_complete_propagates_exit_code() -> None:
    hooks = _RecordingHooks()
    runtime = load_plugin_runtime([_plugin("a", hooks=hooks)])
    runtime.run_on_complete(
        ChxOnCompleteContext(
            command="migrate",
            is_interactive=False,
            json_mode=True,
            exit_code=3,
            options={},
        )
    )
    assert hooks.events == ["complete:migrate:3"]


# ---------- on_schema_loaded threading ----------


class _AppendsTagHook:
    """A schema-hook that appends a marker definition between plugins."""

    def __init__(self, marker: str) -> None:
        self.marker = marker

    def on_schema_loaded(self, ctx: ChxOnSchemaLoadedContext) -> list[Any]:
        new_table = table(
            database="hook",
            name=self.marker,
            engine="MergeTree",
            columns=[ColumnDefinition(name="id", type="UInt64")],
            primary_key=["id"],
            order_by=["id"],
        )
        return [*ctx.definitions, new_table]


def test_on_schema_loaded_threads_definitions_through_chain() -> None:
    runtime = load_plugin_runtime(
        [
            _plugin("a", hooks=_AppendsTagHook("after_a")),
            _plugin("b", hooks=_AppendsTagHook("after_b")),
        ]
    )
    out = runtime.run_on_schema_loaded(
        ChxOnSchemaLoadedContext(
            command="generate",
            config=_config(),
            table_scope=_scope(),
            flags={},
            definitions=[],
            json_mode=False,
        )
    )
    names = [d.name for d in out]
    assert names == ["after_a", "after_b"]


def test_on_schema_loaded_returning_none_keeps_input() -> None:
    class _NoOp:
        def on_schema_loaded(self, ctx: ChxOnSchemaLoadedContext) -> None:
            return None

    runtime = load_plugin_runtime([_plugin("a", hooks=_NoOp())])
    initial_t = table(
        database="d",
        name="t",
        engine="MergeTree",
        columns=[ColumnDefinition(name="id", type="UInt64")],
        primary_key=["id"],
        order_by=["id"],
    )
    out = runtime.run_on_schema_loaded(
        ChxOnSchemaLoadedContext(
            command="generate",
            config=_config(),
            table_scope=_scope(),
            flags={},
            definitions=[initial_t],
            json_mode=False,
        )
    )
    assert len(out) == 1
    assert out[0].name == "t"


# ---------- on_check (collects results) ----------


def test_on_check_collects_results_from_each_plugin() -> None:
    class _Hook:
        def __init__(self, name: str) -> None:
            self.name = name

        def on_check(self, ctx: ChxOnCheckContext) -> ChxOnCheckResult:
            return ChxOnCheckResult(
                plugin=self.name, evaluated=True, ok=True, findings=[]
            )

    runtime = load_plugin_runtime(
        [
            _plugin("a", hooks=_Hook("a")),
            _plugin("b", hooks=_Hook("b")),
        ]
    )
    results = runtime.run_on_check(
        ChxOnCheckContext(
            command="check",
            config=_config(),
            table_scope=_scope(),
            flags={},
            config_path="cfg.py",
            json_mode=False,
            options={},
        )
    )
    assert {r.plugin for r in results} == {"a", "b"}


# ---------- command dispatch ----------


def test_run_plugin_command_returns_int_exit_code() -> None:
    captured: dict[str, object] = {}

    def cmd_run(ctx: Any) -> int:
        captured["called"] = True
        return 42

    runtime = load_plugin_runtime(
        [
            _plugin(
                "my-plugin",
                commands=[ChxPluginCommand(name="do", run=cmd_run)],
            )
        ]
    )
    found = runtime.get_command("my-plugin", "do")
    assert found is not None

    code = runtime.run_plugin_command(
        "my-plugin",
        "do",
        ChxPluginCommandContext(
            plugin_name="my-plugin",
            config=_config(),
            config_path="cfg.py",
            json_mode=False,
            args=[],
            flags={},
            options={},
            raw_options={},
            table_scope=_scope(),
            print=lambda _v: None,
            plugin_runtime=runtime,
            plugin_context=null_plugin_context(),
        ),
    )
    assert code == 42
    assert captured["called"] is True


def test_run_plugin_command_invokes_on_before_plugin_command_short_circuit() -> None:
    """Mirrors TS `runPluginCommand`: if any plugin's on_before_plugin_command
    returns Handled, the command's `run` is skipped and the exit_code propagated.
    """
    command_ran = {"value": False}

    def cmd_run(_ctx: Any) -> int:
        command_ran["value"] = True
        return 0

    class _RoutingHooks:
        def on_before_plugin_command(
            self, _ctx: ChxOnBeforePluginCommandContext
        ) -> ChxOnBeforePluginCommandHandled:
            return ChxOnBeforePluginCommandHandled(exit_code=7)

    runtime = load_plugin_runtime(
        [
            _plugin(
                "router",
                hooks=_RoutingHooks(),
            ),
            _plugin(
                "target",
                commands=[ChxPluginCommand(name="do", run=cmd_run)],
            ),
        ]
    )

    code = runtime.run_plugin_command(
        "target",
        "do",
        ChxPluginCommandContext(
            plugin_name="target",
            config=_config(),
            config_path="cfg.py",
            json_mode=False,
            args=[],
            flags={},
            options={},
            raw_options={},
            table_scope=_scope(),
            print=lambda _v: None,
            plugin_runtime=runtime,
            plugin_context=null_plugin_context(),
        ),
    )

    assert code == 7
    assert command_ran["value"] is False  # short-circuited


def test_run_plugin_command_raises_for_unknown_command() -> None:
    runtime = load_plugin_runtime(
        [_plugin("p", commands=[ChxPluginCommand(name="x", run=lambda _c: 0)])]
    )
    with pytest.raises(PluginValidationError, match="no command"):
        runtime.run_plugin_command(
            "p", "ghost", _make_command_ctx(runtime)
        )


def _make_command_ctx(runtime: PluginRuntime) -> Any:
    return ChxPluginCommandContext(
        plugin_name="p",
        config=_config(),
        config_path="cfg.py",
        json_mode=False,
        args=[],
        flags={},
        options={},
        raw_options={},
        table_scope=_scope(),
        print=lambda _v: None,
        plugin_runtime=runtime,
        plugin_context=null_plugin_context(),
    )


# ---------- error wrapping ----------


class _BoomHook:
    def on_init(self, ctx: ChxOnInitContext) -> None:
        raise ValueError("hook exploded")


def test_third_party_hook_error_is_wrapped_with_plugin_name() -> None:
    runtime = load_plugin_runtime([_plugin("bad", hooks=_BoomHook())])
    with pytest.raises(PluginExecutionError) as excinfo:
        runtime.run_on_init(
            ChxOnInitContext(
                command="generate",
                config_path="cfg.py",
                is_interactive=True,
                json_mode=False,
                flags={},
                config=_config(),
                options={},
            )
        )
    assert excinfo.value.plugin_name == "bad"
    assert "hook exploded" in str(excinfo.value)


def test_internal_plugin_hook_error_is_not_wrapped() -> None:
    runtime_plugins = [
        LoadedPlugin(
            plugin=_plugin("internal", hooks=_BoomHook()),
            options={},
            raw_options={},
            internal=True,
        )
    ]
    runtime = PluginRuntime(runtime_plugins)
    with pytest.raises(ValueError, match="hook exploded"):
        runtime.run_on_init(
            ChxOnInitContext(
                command="generate",
                config_path="cfg.py",
                is_interactive=True,
                json_mode=False,
                flags={},
                config=_config(),
                options={},
            )
        )


# ---------- runtime introspection ----------


def test_get_command_returns_none_when_plugin_missing() -> None:
    runtime = load_plugin_runtime([])
    assert runtime.get_command("nope", "x") is None


def test_get_command_returns_none_when_command_missing() -> None:
    runtime = load_plugin_runtime(
        [_plugin("p", commands=[ChxPluginCommand(name="x", run=lambda _: 0)])]
    )
    assert runtime.get_command("p", "ghost") is None
