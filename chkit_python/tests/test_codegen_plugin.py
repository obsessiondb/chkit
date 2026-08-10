"""Tests for the chkit_plugin_codegen package.

Coverage:
- ClickHouse → Python type mapping (scalars, Nullable, LowCardinality, Array,
  Map, Tuple, JSON, SimpleAggregateFunction, unsupported types).
- ``generate_type_artifacts`` end-to-end: rendering, naming styles, include_views,
  unsupported-type behaviour (raise vs warn), bigint mode, deterministic ordering.
- Plugin wiring: ``codegen()`` factory shape, ``--check`` exit codes,
  write-mode atomicity, ``on_check`` hook.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from chkit import table
from chkit.cli.table_scope import TableScope
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
    ColumnDefinition,
    MaterializedViewDefinition,
    MaterializedViewRefresh,  # noqa: F401  (used implicitly via model_validate)
    TableRef,
    ViewDefinition,
)
from chkit.plugins import (
    ChxCheckFinding,
    ChxOnCheckContext,
    ChxOnCheckReportContext,
    ChxOnCheckResult,
    ChxPluginCommandContext,
    ChxPluginManifest,
    PluginContext,
)
from chkit_plugin_codegen import (
    CodegenConfigError,
    CodegenOptions,
    PluginConfig,
    UnsupportedTypeError,
    codegen,
    create_codegen_plugin,
    generate_type_artifacts,
    map_column_type,
    normalize_codegen_options,
)

# ---------- helpers ----------


def _col(name: str, type_: str, *, nullable: bool | None = None) -> ColumnDefinition:
    return ColumnDefinition(name=name, type=type_, nullable=nullable)


def _t(*, database: str = "db", name: str = "t", columns: list[ColumnDefinition]) -> Any:
    return table(
        database=database,
        name=name,
        columns=[c.model_dump() for c in columns],
        engine="MergeTree",
        primary_key=["id"] if any(c.name == "id" for c in columns) else [columns[0].name],
        order_by=["id"] if any(c.name == "id" for c in columns) else [columns[0].name],
    )


def _resolved_config(tmp_path: Path) -> ChxResolvedConfig:
    schema_path = tmp_path / "schema.py"
    schema_path.write_text("from chkit import table\n", encoding="utf-8")
    return ChxResolvedConfig(
        schema_=[str(schema_path)],
        out_dir=str(tmp_path),
        migrations_dir=str(tmp_path / "m"),
        meta_dir=str(tmp_path / "meta"),
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )


# ---------- options ----------


def test_normalize_codegen_options_fills_defaults() -> None:
    opts = normalize_codegen_options(None)
    assert opts.bigint_mode == "int"
    assert opts.table_name_style == "pascal"
    assert opts.include_views is False
    assert opts.out_file.endswith("chkit_models.py")


def test_normalize_codegen_options_accepts_dict_camel() -> None:
    opts = normalize_codegen_options(
        {"outFile": "./out.py", "bigintMode": "str", "includeViews": True}
    )
    assert opts.out_file == "./out.py"
    assert opts.bigint_mode == "str"
    assert opts.include_views is True


def test_normalize_codegen_options_passes_through_codegen_options() -> None:
    full = CodegenOptions(out_file="./x.py")
    assert normalize_codegen_options(full) is full


def test_normalize_codegen_options_rejects_extra_keys() -> None:
    with pytest.raises(CodegenConfigError):
        normalize_codegen_options({"bogus": True})


# ---------- type mapping ----------


def _opts(**kw: object) -> CodegenOptions:
    return CodegenOptions.model_validate({"out_file": "./x.py", **kw})


def test_map_scalar_types() -> None:
    opts = _opts()
    assert map_column_type(column=_col("a", "String"), path="x", options=opts).py_type == "str"
    assert map_column_type(column=_col("a", "Int32"), path="x", options=opts).py_type == "int"
    assert map_column_type(column=_col("a", "Float64"), path="x", options=opts).py_type == "float"
    assert map_column_type(column=_col("a", "Bool"), path="x", options=opts).py_type == "bool"
    assert (
        map_column_type(column=_col("a", "DateTime64(3)"), path="x", options=opts).py_type
        == "str"
    )


def test_map_bigint_mode_int_vs_str() -> None:
    assert (
        map_column_type(
            column=_col("a", "UInt64"), path="x", options=_opts(bigint_mode="int")
        ).py_type
        == "int"
    )
    assert (
        map_column_type(
            column=_col("a", "UInt64"), path="x", options=_opts(bigint_mode="str")
        ).py_type
        == "str"
    )


def test_map_nullable_appends_union_none() -> None:
    result = map_column_type(
        column=_col("a", "Nullable(String)"), path="x", options=_opts()
    )
    assert result.py_type == "str | None"
    assert result.nullable is True


def test_map_low_cardinality_unwraps() -> None:
    assert (
        map_column_type(
            column=_col("a", "LowCardinality(String)"), path="x", options=_opts()
        ).py_type
        == "str"
    )


def test_map_array_and_map_and_tuple() -> None:
    opts = _opts()
    assert (
        map_column_type(column=_col("a", "Array(UInt32)"), path="x", options=opts).py_type
        == "list[int]"
    )
    assert (
        map_column_type(
            column=_col("a", "Map(String, Int32)"), path="x", options=opts
        ).py_type
        == "dict[str, int]"
    )
    assert (
        map_column_type(
            column=_col("a", "Tuple(String, Int32, Bool)"), path="x", options=opts
        ).py_type
        == "tuple[str, int, bool]"
    )


def test_map_nested_nullable_inside_array() -> None:
    assert (
        map_column_type(
            column=_col("a", "Array(Nullable(String))"), path="x", options=_opts()
        ).py_type
        == "list[str | None]"
    )


def test_map_simple_aggregate_function_uses_value_type() -> None:
    assert (
        map_column_type(
            column=_col("a", "SimpleAggregateFunction(sum, UInt64)"),
            path="x",
            options=_opts(),
        ).py_type
        == "int"
    )


def test_map_json_returns_dict_any() -> None:
    assert (
        map_column_type(column=_col("a", "JSON"), path="x", options=_opts()).py_type
        == "dict[str, Any]"
    )


def test_map_unsupported_raises_by_default() -> None:
    with pytest.raises(UnsupportedTypeError):
        map_column_type(
            column=_col("a", "Polygon"), path="db.t.a", options=_opts()
        )


def test_map_unsupported_warns_when_disabled() -> None:
    result = map_column_type(
        column=_col("a", "Polygon"),
        path="db.t.a",
        options=_opts(fail_on_unsupported_type=False),
    )
    assert result.py_type == "Any"
    assert result.finding is not None
    assert result.finding.code == "codegen_unsupported_type"


def test_map_column_nullable_flag_wins_when_resolved_not_nullable() -> None:
    result = map_column_type(
        column=_col("a", "String", nullable=True), path="x", options=_opts()
    )
    assert result.py_type == "str | None"
    assert result.nullable is True


# ---------- generator ----------


def test_generate_type_artifacts_emits_header_and_class() -> None:
    table_def = _t(columns=[_col("id", "UInt64"), _col("name", "String")])
    out = generate_type_artifacts(definitions=[table_def])
    assert "auto-generated by chkit codegen" in out.content
    assert "class DbTRow(BaseModel):" in out.content
    assert "id: int" in out.content
    assert "name: str" in out.content


def test_generate_type_artifacts_sanitizes_python_keyword_column() -> None:
    table_def = _t(columns=[_col("class", "String")])
    out = generate_type_artifacts(definitions=[table_def])
    # 'class' isn't a valid attribute → rendered with Field alias
    assert 'alias=' in out.content
    assert "BaseModel" in out.content


def test_generate_type_artifacts_handles_dash_column() -> None:
    table_def = _t(columns=[_col("user-id", "UInt64")])
    out = generate_type_artifacts(definitions=[table_def])
    assert "user_id: int = Field(..., alias='user-id')" in out.content


def test_generate_type_artifacts_naming_style_camel() -> None:
    t = _t(database="events", name="user_actions", columns=[_col("id", "UInt64")])
    out = generate_type_artifacts(
        definitions=[t], options={"tableNameStyle": "camel"}
    )
    assert "class eventsUserActionsRow(BaseModel):" in out.content


def test_generate_type_artifacts_naming_style_raw() -> None:
    t = _t(database="events", name="user_actions", columns=[_col("id", "UInt64")])
    out = generate_type_artifacts(
        definitions=[t], options={"tableNameStyle": "raw"}
    )
    assert "class events_user_actions_row(BaseModel):" in out.content


def test_generate_type_artifacts_excludes_views_by_default() -> None:
    t = _t(columns=[_col("id", "UInt64")])
    view = ViewDefinition(database="db", name="v", as_="SELECT 1")
    out = generate_type_artifacts(definitions=[t, view])
    assert "class DbVRow" not in out.content
    assert out.declaration_count == 1


def test_generate_type_artifacts_includes_views_when_enabled() -> None:
    t = _t(columns=[_col("id", "UInt64")])
    view = ViewDefinition(database="db", name="v", as_="SELECT 1")
    mv = MaterializedViewDefinition(
        database="db",
        name="mv",
        to=TableRef(database="db", name="t"),
        as_="SELECT * FROM db.t",
    )
    out = generate_type_artifacts(
        definitions=[t, view, mv], options={"includeViews": True}
    )
    assert "TypeAlias = dict[str, Any]" in out.content
    assert out.declaration_count == 3


def test_generate_type_artifacts_sorts_definitions_deterministically() -> None:
    a = _t(database="z", name="a", columns=[_col("id", "UInt64")])
    b = _t(database="a", name="z", columns=[_col("id", "UInt64")])
    out1 = generate_type_artifacts(definitions=[a, b]).content
    out2 = generate_type_artifacts(definitions=[b, a]).content
    assert out1 == out2
    # 'a' database comes before 'z'
    assert out1.index("AZRow") < out1.index("ZARow")


def test_generate_type_artifacts_unsupported_type_warns_with_option() -> None:
    table_def = _t(columns=[_col("p", "Polygon")])
    out = generate_type_artifacts(
        definitions=[table_def], options={"failOnUnsupportedType": False}
    )
    assert any(f.code == "codegen_unsupported_type" for f in out.findings)
    assert ": Any" in out.content


# ---------- plugin factory ----------


def test_codegen_factory_returns_valid_plugin() -> None:
    plugin = codegen()
    assert plugin.manifest == ChxPluginManifest(name="codegen", api_version=1)
    assert plugin.commands is not None
    assert plugin.commands[0].name == "codegen"
    assert hasattr(plugin.hooks, "on_check")
    assert hasattr(plugin.hooks, "on_check_report")


def test_codegen_factory_accepts_plugin_config() -> None:
    plugin = create_codegen_plugin(PluginConfig(out_file="./gen.py"))
    assert plugin.options_schema is PluginConfig


# ---------- command run ----------


def _make_command_context(
    *,
    config: ChxResolvedConfig,
    tmp_path: Path,
    options: dict[str, Any],
    flags: dict[str, Any],
    json_mode: bool = False,
    msgs: list[Any] | None = None,
) -> ChxPluginCommandContext:
    return ChxPluginCommandContext(
        plugin_name="codegen",
        config=config,
        config_path=str(tmp_path / "clickhouse.config.py"),
        json_mode=json_mode,
        args=[],
        flags=flags,
        options=options,
        raw_options=dict(options),
        table_scope=TableScope(enabled=False),
        print=(msgs.append if msgs is not None else lambda _v: None),
        plugin_runtime=MagicMock(),
        plugin_context=PluginContext(executor=None, has_executor=False),
    )


def _write_schema_with_table(tmp_path: Path) -> Path:
    schema_path = tmp_path / "schema.py"
    schema_path.write_text(
        "from chkit import table\n"
        "_ = table(\n"
        "  database='db', name='t',\n"
        "  columns=[{'name': 'id', 'type': 'UInt64'}, {'name': 'name', 'type': 'String'}],\n"
        "  engine='MergeTree', primary_key=['id'], order_by=['id'],\n"
        ")\n",
        encoding="utf-8",
    )
    return schema_path


def _config_for_schema(tmp_path: Path, schema_path: Path) -> ChxResolvedConfig:
    return ChxResolvedConfig(
        schema_=[str(schema_path)],
        out_dir=str(tmp_path),
        migrations_dir=str(tmp_path / "m"),
        meta_dir=str(tmp_path / "meta"),
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )


def test_command_writes_file_on_first_run(tmp_path: Path) -> None:
    schema = _write_schema_with_table(tmp_path)
    cfg = _config_for_schema(tmp_path, schema)
    out_file = tmp_path / "generated" / "models.py"
    plugin = codegen()
    assert plugin.commands is not None
    msgs: list[Any] = []
    code = plugin.commands[0].run(
        _make_command_context(
            config=cfg,
            tmp_path=tmp_path,
            options={"out_file": str(out_file)},
            flags={},
            msgs=msgs,
        )
    )
    assert code == 0
    assert out_file.exists()
    content = out_file.read_text(encoding="utf-8")
    assert "class DbTRow(BaseModel):" in content


def test_command_check_mode_returns_zero_when_up_to_date(tmp_path: Path) -> None:
    schema = _write_schema_with_table(tmp_path)
    cfg = _config_for_schema(tmp_path, schema)
    out_file = tmp_path / "models.py"
    plugin = codegen()
    assert plugin.commands is not None
    # Generate first
    plugin.commands[0].run(
        _make_command_context(
            config=cfg, tmp_path=tmp_path, options={"out_file": str(out_file)}, flags={}
        )
    )
    msgs: list[Any] = []
    code = plugin.commands[0].run(
        _make_command_context(
            config=cfg,
            tmp_path=tmp_path,
            options={"out_file": str(out_file)},
            flags={"--check": True},
            msgs=msgs,
        )
    )
    assert code == 0
    assert any("up-to-date" in str(m) for m in msgs)


def test_command_check_mode_returns_one_when_missing(tmp_path: Path) -> None:
    schema = _write_schema_with_table(tmp_path)
    cfg = _config_for_schema(tmp_path, schema)
    out_file = tmp_path / "models.py"
    plugin = codegen()
    assert plugin.commands is not None
    msgs: list[Any] = []
    code = plugin.commands[0].run(
        _make_command_context(
            config=cfg,
            tmp_path=tmp_path,
            options={"out_file": str(out_file)},
            flags={"--check": True},
            msgs=msgs,
        )
    )
    assert code == 1
    assert any("check failed" in str(m) for m in msgs)


def test_command_check_mode_returns_one_when_stale(tmp_path: Path) -> None:
    schema = _write_schema_with_table(tmp_path)
    cfg = _config_for_schema(tmp_path, schema)
    out_file = tmp_path / "models.py"
    out_file.write_text("# stale\n", encoding="utf-8")
    plugin = codegen()
    assert plugin.commands is not None
    code = plugin.commands[0].run(
        _make_command_context(
            config=cfg,
            tmp_path=tmp_path,
            options={"out_file": str(out_file)},
            flags={"--check": True},
        )
    )
    assert code == 1


def test_command_json_mode_prints_payload(tmp_path: Path) -> None:
    schema = _write_schema_with_table(tmp_path)
    cfg = _config_for_schema(tmp_path, schema)
    out_file = tmp_path / "models.py"
    plugin = codegen()
    assert plugin.commands is not None
    msgs: list[Any] = []
    code = plugin.commands[0].run(
        _make_command_context(
            config=cfg,
            tmp_path=tmp_path,
            options={"out_file": str(out_file)},
            flags={},
            json_mode=True,
            msgs=msgs,
        )
    )
    assert code == 0
    payload = msgs[0]
    assert payload["ok"] is True
    assert payload["mode"] == "write"
    assert payload["declarationCount"] == 1


# ---------- on_check hook ----------


def test_on_check_hook_returns_ok_when_up_to_date(tmp_path: Path) -> None:
    schema = _write_schema_with_table(tmp_path)
    cfg = _config_for_schema(tmp_path, schema)
    out_file = tmp_path / "models.py"
    plugin = codegen({"outFile": str(out_file)})
    # Generate first
    assert plugin.commands is not None
    plugin.commands[0].run(
        _make_command_context(
            config=cfg, tmp_path=tmp_path, options={"out_file": str(out_file)}, flags={}
        )
    )
    hook_ctx = ChxOnCheckContext(
        command="check",
        config=cfg,
        table_scope=TableScope(enabled=False),
        flags={},
        config_path=str(tmp_path / "clickhouse.config.py"),
        json_mode=False,
        options={"out_file": str(out_file)},
    )
    result = plugin.hooks.on_check(hook_ctx)
    assert result is not None
    assert result.ok is True
    assert result.findings == []


def test_on_check_report_prints_status(tmp_path: Path) -> None:
    plugin = codegen()
    msgs: list[str] = []
    plugin.hooks.on_check_report(
        ChxOnCheckReportContext(
            result=ChxOnCheckResult(plugin="codegen", evaluated=True, ok=True),
            print=msgs.append,
        )
    )
    assert msgs == ["codegen check: ok"]

    msgs.clear()
    plugin.hooks.on_check_report(
        ChxOnCheckReportContext(
            result=ChxOnCheckResult(
                plugin="codegen",
                evaluated=True,
                ok=False,
                findings=[
                    ChxCheckFinding(
                        code="codegen_stale_output", message="bad", severity="error"
                    )
                ],
            ),
            print=msgs.append,
        )
    )
    assert msgs == ["codegen check: failed (codegen_stale_output)"]
