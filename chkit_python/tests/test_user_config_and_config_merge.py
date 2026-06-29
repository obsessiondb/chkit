"""Tests for ``chkit.cli.user_config`` and ``chkit.cli.config_merge``."""

from __future__ import annotations

from pathlib import Path

import pytest

from chkit.cli.config_merge import merge_user_config, plugin_name_of
from chkit.cli.user_config import (
    USER_CREDENTIALS_FILE,
    USER_PROFILE_CONFIG_FILE,
    get_user_config_dir,
    get_user_credentials_path,
    get_user_profile_config_path,
)
from chkit.core.model import (
    ChxCheckConfig,
    ChxSafetyConfig,
    ChxUserClickHouseConfig,
    ChxUserConfig,
)
from chkit.plugins import ChxPlugin, ChxPluginManifest

# ---------- user_config ----------


def test_get_user_config_dir_honors_xdg(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert get_user_config_dir() == tmp_path / "chkit"


def test_get_user_config_dir_falls_back_to_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    assert get_user_config_dir() == Path.home() / ".config" / "chkit"


def test_user_config_paths_compose_constants(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert get_user_profile_config_path() == tmp_path / "chkit" / USER_PROFILE_CONFIG_FILE
    assert get_user_credentials_path() == tmp_path / "chkit" / USER_CREDENTIALS_FILE


# ---------- config_merge: plugin_name_of ----------


def test_plugin_name_of_extracts_from_chxplugin() -> None:
    plugin = ChxPlugin(
        manifest=ChxPluginManifest(name="codegen", api_version=1)
    )
    assert plugin_name_of(plugin) == "codegen"


def test_plugin_name_of_extracts_from_wrapped_registration() -> None:
    plugin = ChxPlugin(
        manifest=ChxPluginManifest(name="codegen", api_version=1)
    )
    assert plugin_name_of({"plugin": plugin}) == "codegen"
    assert plugin_name_of({"name": "override", "plugin": plugin}) == "override"


def test_plugin_name_of_returns_none_when_unknown() -> None:
    assert plugin_name_of(None) is None
    assert plugin_name_of({}) is None
    assert plugin_name_of(object()) is None


# ---------- config_merge: merge_user_config ----------


def _ucfg(**overrides: object) -> ChxUserConfig:
    base: dict[str, object] = {"schema": "./schema.py"}
    base.update(overrides)
    return ChxUserConfig.model_validate(base)


def test_overlay_scalar_wins_when_set() -> None:
    base = _ucfg(outDir="./base/out")
    overlay = _ucfg(outDir="./overlay/out")
    merged = merge_user_config(base, overlay)
    assert merged.out_dir == "./overlay/out"


def test_overlay_scalar_none_falls_back_to_base() -> None:
    base = _ucfg(outDir="./base/out")
    overlay = _ucfg()  # no outDir
    merged = merge_user_config(base, overlay)
    assert merged.out_dir == "./base/out"


def test_merge_clickhouse_shallow_overlay_wins() -> None:
    base = _ucfg(
        clickhouse=ChxUserClickHouseConfig(
            url="http://base", username="base", database="d1"
        ),
    )
    overlay = _ucfg(
        clickhouse=ChxUserClickHouseConfig(url="http://overlay", password="p"),
    )
    merged = merge_user_config(base, overlay)
    assert merged.clickhouse is not None
    assert merged.clickhouse.url == "http://overlay"
    assert merged.clickhouse.username == "base"  # preserved
    assert merged.clickhouse.password == "p"
    assert merged.clickhouse.database == "d1"  # preserved


def test_merge_plugins_overlay_replaces_by_name() -> None:
    base_plugin = ChxPlugin(manifest=ChxPluginManifest(name="codegen", api_version=1))
    other_plugin = ChxPlugin(manifest=ChxPluginManifest(name="pull", api_version=1))
    overlay_plugin = ChxPlugin(manifest=ChxPluginManifest(name="codegen", api_version=1))
    base = _ucfg(plugins=[base_plugin, other_plugin])
    overlay = _ucfg(plugins=[overlay_plugin])
    merged = merge_user_config(base, overlay)
    assert merged.plugins is not None
    names = [plugin_name_of(p) for p in merged.plugins]
    # 'other' from base preserved; 'codegen' replaced by overlay's entry.
    assert names == ["pull", "codegen"]
    assert merged.plugins[1] is overlay_plugin


def test_merge_check_overlay_overrides_specific_fields() -> None:
    base = _ucfg(
        check=ChxCheckConfig(fail_on_pending=True, fail_on_drift=False),
    )
    overlay = _ucfg(check=ChxCheckConfig(fail_on_drift=True))
    merged = merge_user_config(base, overlay)
    assert merged.check is not None
    assert merged.check.fail_on_pending is True  # base preserved
    assert merged.check.fail_on_drift is True  # overlay won


def test_merge_safety_overlay_overrides() -> None:
    base = _ucfg(safety=ChxSafetyConfig(allow_destructive=False))
    overlay = _ucfg(safety=ChxSafetyConfig(allow_destructive=True))
    merged = merge_user_config(base, overlay)
    assert merged.safety is not None
    assert merged.safety.allow_destructive is True
