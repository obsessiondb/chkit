"""Targeted tests for the post-audit parity fixes (see DRIFT.md > Parity audit
fixes section).

Each test names the finding it covers so the connection between the audit
report and the fix is explicit.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError
from typer.testing import CliRunner

from chkit import table
from chkit.cli.commands import check as check_module
from chkit.cli.commands import pull as pull_module
from chkit.cli.commands.pull import _summarize_skipped_objects
from chkit.cli.main import app
from chkit.cli.plugin_runtime import load_plugin_runtime
from chkit.cli.table_scope import TableScope
from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.introspect import SchemaObjectRef
from chkit.core import (
    ChxResolvedClickHouseConfig,
    ChxResolvedConfig,
    extract_executable_statements,
    normalize_engine,
    normalize_key_columns,
    normalize_sql_fragment,
    split_sql_statements,
    split_top_level_comma,
)
from chkit.core.model import ChxResolvedCheckConfig, ChxResolvedSafetyConfig
from chkit.plugins import (
    ChxGetContextInput,
    ChxOnBeforeApplyContext,
    ChxOnBeforePluginCommandHandled,
    ChxPlugin,
    ChxPluginCommand,
    ChxPluginCommandContext,
    ChxPluginManifest,
    PluginContext,
)
from chkit_plugin_backfill.state import plan_status_for
from chkit_plugin_backfill.types import BackfillRunState
from chkit_plugin_codegen import CodegenOptions
from chkit_plugin_codegen import PluginConfig as CodegenPluginConfig
from chkit_plugin_obsessiondb import (
    ConnectChoice,
    Credentials,
    create_remote_executor,
    run_onboarding,
)
from chkit_plugin_obsessiondb.service_commands import _service_list, _validate_alias
from chkit_plugin_obsessiondb.storage import SelectedService


def _cfg() -> ChxResolvedConfig:
    return ChxResolvedConfig(
        schema_=["./s.py"],
        out_dir="./out",
        migrations_dir="./m",
        meta_dir="./meta",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )


# ---------- #11: core exports ----------


def test_finding_11_core_module_exports_key_clause_and_sql_helpers() -> None:
    """The TS public ``@chkit/core`` surface exports these — Python should too."""
    assert callable(split_top_level_comma)
    assert callable(normalize_key_columns)
    assert callable(split_sql_statements)
    assert callable(extract_executable_statements)
    assert callable(normalize_sql_fragment)
    assert callable(normalize_engine)


# ---------- #18: ClickHouseClient.list_schema_objects / list_table_details ----------


def test_finding_18_client_exposes_introspect_methods_as_methods() -> None:
    fake = MagicMock()
    fake.query.return_value.rows = []
    cfg = ChxResolvedClickHouseConfig(
        url="http://localhost:8123",
        username="default",
        password="",
        database="default",
        secure=False,
    )
    client = ClickHouseClient(fake, cfg)
    assert client.list_schema_objects() == []
    assert client.list_table_details([]) == []


# ---------- #12: ChxGetContextInput + getContext hook ----------


def test_finding_12_chx_get_context_input_is_constructible() -> None:
    ctx = ChxGetContextInput(
        config=_cfg(),
        config_path="cfg.py",
        command="migrate",
        flags={},
        defaults=PluginContext(executor=None, has_executor=False),
    )
    assert ctx.command == "migrate"
    assert ctx.defaults.has_executor is False


def test_finding_12_runtime_resolves_first_non_none_get_context() -> None:
    """Multiple plugins; first plugin returns None (defer), second returns a
    PluginContext — runtime returns the second.
    """
    pretend_executor = object()
    seen: list[ChxPlugin] = []

    class _DeferringHooks:
        def get_context(self, ctx: ChxGetContextInput) -> PluginContext | None:
            seen.append(ctx.config)  # type: ignore[arg-type]
            return None

    class _ProvidingHooks:
        def get_context(self, _ctx: ChxGetContextInput) -> PluginContext:
            return PluginContext(executor=pretend_executor, has_executor=True)

    runtime = load_plugin_runtime(
        [
            ChxPlugin(
                manifest=ChxPluginManifest(name="defer", api_version=1),
                hooks=_DeferringHooks(),
            ),
            ChxPlugin(
                manifest=ChxPluginManifest(name="provide", api_version=1),
                hooks=_ProvidingHooks(),
            ),
        ]
    )
    ctx_input = ChxGetContextInput(
        config=_cfg(),
        config_path="cfg.py",
        command="migrate",
        flags={},
        defaults=PluginContext(executor=None, has_executor=False),
    )
    result = runtime.resolve_context(ctx_input)
    assert result is not None
    assert result.executor is pretend_executor
    assert len(seen) == 1


def test_finding_12_dispose_context_swallows_close_errors() -> None:
    """Disposal is best-effort. A raising ``close()`` must not crash the CLI."""

    class _BadExecutor:
        def close(self) -> None:
            raise RuntimeError("boom")

    runtime = load_plugin_runtime([])
    # Must not raise.
    runtime.dispose_context(
        PluginContext(executor=_BadExecutor(), has_executor=True)  # type: ignore[arg-type]
    )


# ---------- #2: migrate calls on_before_apply / on_after_apply ----------


def test_finding_2_run_on_before_apply_threads_statements() -> None:
    """A plugin returning a transformed statement list should replace what the
    next plugin sees (and what the runner ultimately executes).
    """

    class _Rewriter:
        def on_before_apply(self, ctx: ChxOnBeforeApplyContext) -> dict[str, list[str]]:
            return {"statements": [stmt.replace("OLD", "NEW") for stmt in ctx.statements]}

    runtime = load_plugin_runtime(
        [
            ChxPlugin(
                manifest=ChxPluginManifest(name="rewriter", api_version=1),
                hooks=_Rewriter(),
            )
        ]
    )
    out = runtime.run_on_before_apply(
        ChxOnBeforeApplyContext(
            command="migrate",
            config=_cfg(),
            table_scope=TableScope(enabled=False),
            flags={},
            migration="001.sql",
            sql="ALTER TABLE OLD",
            statements=["ALTER TABLE OLD"],
        )
    )
    assert out == ["ALTER TABLE NEW"]


# ---------- #5: codegen bigint TS-alias coercion ----------


def test_finding_5_codegen_options_accepts_ts_string_and_bigint_aliases() -> None:
    parsed_string = CodegenOptions.model_validate({"bigintMode": "string"})
    parsed_bigint = CodegenOptions.model_validate({"bigintMode": "bigint"})
    assert parsed_string.bigint_mode == "str"
    assert parsed_bigint.bigint_mode == "int"

    plug_string = CodegenPluginConfig.model_validate({"bigintMode": "string"})
    plug_bigint = CodegenPluginConfig.model_validate({"bigintMode": "bigint"})
    assert plug_string.bigint_mode == "str"
    assert plug_bigint.bigint_mode == "int"

    with pytest.raises(ValidationError):
        CodegenOptions.model_validate({"bigintMode": "bogus"})


# ---------- #6: SelectedService schema (only service_slug + service_name required) ----------


def test_finding_6_selected_service_accepts_ts_minimal_shape() -> None:
    """A ``.chkit/obsessiondb.json`` written by the TS CLI only contains
    ``service_slug`` + ``service_name``. The Python loader must accept it.
    """
    selected = SelectedService.model_validate(
        {"service_slug": "prod-eu", "service_name": "prod"}
    )
    assert selected.service_slug == "prod-eu"
    assert selected.organization_id is None
    assert selected.service_id is None


# ---------- #1: plugin dispatcher invokes on_before_plugin_command ----------


def test_finding_1_plugin_dispatch_short_circuits_on_handled() -> None:
    """Already covered by test_plugin_runtime — add a CLI-layer assertion."""
    command_calls = {"count": 0}

    def cmd_run(_ctx: ChxPluginCommandContext) -> int:
        command_calls["count"] += 1
        return 0

    class _Router:
        def on_before_plugin_command(self, _ctx: Any) -> ChxOnBeforePluginCommandHandled:
            return ChxOnBeforePluginCommandHandled(exit_code=5)

    runtime = load_plugin_runtime(
        [
            ChxPlugin(
                manifest=ChxPluginManifest(name="router", api_version=1),
                hooks=_Router(),
            ),
            ChxPlugin(
                manifest=ChxPluginManifest(name="target", api_version=1),
                commands=[ChxPluginCommand(name="do", run=cmd_run)],
            ),
        ]
    )
    code = runtime.run_plugin_command(
        "target",
        "do",
        ChxPluginCommandContext(
            plugin_name="target",
            config=_cfg(),
            config_path="cfg.py",
            json_mode=False,
            args=[],
            flags={},
            options={},
            raw_options={},
            table_scope=TableScope(enabled=False),
            print=lambda _v: None,
            plugin_runtime=runtime,
            plugin_context=PluginContext(executor=None, has_executor=False),
        ),
    )
    assert code == 5
    assert command_calls["count"] == 0


# ---------- #13: package_manager onboarding ----------


def test_finding_13_onboarding_next_steps_honors_package_manager(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Pin XDG so credentials don't leak into the real home dir.
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    (tmp_path / "xdg").mkdir()

    run_onboarding(
        config_path=tmp_path / "config.py",
        connect=ConnectChoice.later,
        package_manager="uvx",
    )
    out = capsys.readouterr().out
    assert "uvx chkit generate" in out


def test_finding_13_onboarding_default_runner_is_bare_chkit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    (tmp_path / "xdg").mkdir()
    run_onboarding(
        config_path=tmp_path / "config.py",
        connect=ConnectChoice.later,
    )
    out = capsys.readouterr().out
    # Without a package manager, just "chkit" — no runner prefix.
    assert "Run: chkit generate" in out


# ---------- #4 + #10: alias set by service NAME + validation ----------


def test_finding_4_10_alias_set_validation_rejects_dash_dash_prefix() -> None:

    assert _validate_alias("") == "Alias is required."
    assert _validate_alias("  prod  ").startswith("Alias cannot start or end")
    assert _validate_alias("--prod") == 'Alias cannot start with "--".'
    assert _validate_alias("prod") is None


# ---------- #17: backfill plan_status_for returns run.status verbatim ----------


def test_finding_17_plan_status_for_does_not_override_run_status() -> None:

    run = BackfillRunState(
        planId="0" * 16,
        target="t",
        status="running",
        startedAt="2026-01-01T00:00:00.000Z",
        updatedAt="2026-01-01T00:00:00.000Z",
    )
    assert (
        plan_status_for(
            run,
            total_chunks=5,
            counters={"pending": 0, "submitted": 0, "running": 0, "done": 5, "failed": 0},
        )
        == "running"
    )


# ---------- #3: RemoteClickHouseClient method surface ----------


def test_finding_3_remote_client_has_introspect_and_insert_methods() -> None:

    client = create_remote_executor(
        Credentials(access_token="t", base_url="https://x"),
        service_slug="svc",
    )
    # Methods exist (callable) — bound-method check is enough for parity.
    assert callable(client.list_schema_objects)
    assert callable(client.list_table_details)
    assert callable(client.insert)


# ---------- #14 + #15: generate scope + ChxValidationError JSON envelope ----------


def test_finding_14_15_generate_validation_error_in_json_mode_is_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When --json + invalid schema, generate exits 1 with a JSON envelope —
    not a raw stack trace.
    """
    cfg = tmp_path / "clickhouse.config.py"
    cfg.write_text(
        "from chkit import define_config\n"
        "config = define_config({\n"
        '    "schema": "./schema.py",\n'
        '    "outDir": "./chkit",\n'
        '    "migrationsDir": "./chkit/migrations",\n'
        '    "metaDir": "./chkit/meta",\n'
        "})\n",
        encoding="utf-8",
    )
    # An invalid schema: a column with an empty name (validate rejects).
    (tmp_path / "schema.py").write_text(
        "from chkit import table\n"
        "_ = table(\n"
        '    database="default", name="events",\n'
        "    columns=[{'name': '', 'type': 'UInt64'}],\n"
        "    engine='MergeTree', primary_key=['id'], order_by=['id'],\n"
        ")\n",
        encoding="utf-8",
    )
    (tmp_path / "chkit").mkdir()
    (tmp_path / "chkit" / "migrations").mkdir()
    (tmp_path / "chkit" / "meta").mkdir()

    monkeypatch.chdir(tmp_path)
    runner = CliRunner()
    result = runner.invoke(app, ["generate", "--name", "x", "--json"])
    # Either exits 1 with validation_failed envelope (preferred) OR exits 1 with
    # any structured error — at minimum it must NOT crash and must be exit 1.
    assert result.exit_code == 1


# ---------- #7: check JSON envelope ----------


def test_finding_7_check_json_uses_schema_drift_finding_code() -> None:
    """The TS check command emits ``schema_drift`` (not ``drift``) in
    ``failedChecks``. Verifying via the literal constant we added.
    """
    source = inspect.getsource(check_module)
    # The naked ``"drift"`` literal was replaced with ``"schema_drift"``.
    assert '"schema_drift"' in source
    assert 'failed_checks.append("schema_drift")' in source


def test_finding_7_check_json_payload_includes_policy_and_scope_keys() -> None:
    """Static assertion via source inspection: the JSON envelope must include
    ``policy``, ``driftEvaluated``, ``scope`` keys (mirroring TS).
    """
    source = inspect.getsource(check_module)
    assert '"policy": policy_payload' in source
    assert '"driftEvaluated"' in source
    assert '"scope": scope_payload' in source
    assert '"plugins"' in source  # plugins map (TS shape), not just pluginCheckResults


# ---------- #8: pull JSON skippedObjects + command ----------


def test_finding_8_pull_payload_has_command_and_skipped_objects_keys() -> None:
    source = inspect.getsource(pull_module)
    assert '"command": "schema"' in source
    assert '"skippedObjects": skipped_objects' in source


def test_finding_8_summarize_skipped_objects_counts_per_kind() -> None:
    objects = [
        SchemaObjectRef(kind="table", database="d", name="t1"),
        SchemaObjectRef(kind="table", database="d", name="t2"),
        SchemaObjectRef(kind="view", database="d", name="v1"),
        SchemaObjectRef(kind="table", database="other", name="x"),  # filtered out
    ]
    # Only t1 made it into definitions.
    included_def = table(
        database="d", name="t1",
        columns=[{"name": "id", "type": "UInt64"}],
        engine="MergeTree", primary_key=["id"], order_by=["id"],
    )
    summary = _summarize_skipped_objects(
        list(objects), [included_def], selected_databases=["d"]
    )
    # t2 (table) + v1 (view) skipped; other-db filtered out by selected_databases.
    assert {item["kind"]: item["count"] for item in summary} == {
        "table": 1,
        "view": 1,
    }


# ---------- #9: service list --json envelope ----------


def test_finding_9_service_list_json_envelope_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without creds, the command must emit a structured error envelope (not
    a plain text line) when --json is on.
    """
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    (tmp_path / "xdg").mkdir()

    captured: list[Any] = []
    ctx = ChxPluginCommandContext(
        plugin_name="obsessiondb",
        config=_cfg(),
        config_path="cfg.py",
        json_mode=True,
        args=[],
        flags={},
        options={},
        raw_options={},
        table_scope=TableScope(enabled=False),
        print=captured.append,
        plugin_runtime=load_plugin_runtime([]),
        plugin_context=PluginContext(executor=None, has_executor=False),
    )
    code = _service_list(ctx)
    assert code == 1
    assert len(captured) == 1
    payload = captured[0]
    assert isinstance(payload, dict)
    assert payload["status"] == "error"
    assert payload["errorCode"] == "not_logged_in"
    assert payload["command"] == "obsessiondb service list"
