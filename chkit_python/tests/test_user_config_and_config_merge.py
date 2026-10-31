"""Tests for ``chkit.cli.user_config`` and ``chkit.cli.config_merge``."""

from __future__ import annotations

from pathlib import Path

import pytest

from chkit.cli.config_loader import load_config
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
    ChxConfigEnv,
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


def test_load_config_supports_function_config(tmp_path: Path) -> None:
    """TS parity: `config` may be a callable receiving ChxConfigEnv."""
    config_file = tmp_path / "clickhouse.config.py"
    config_file.write_text(
        "from chkit import define_config\n"
        "config = define_config(\n"
        "    lambda env: {\n"
        '        "schema": f"./schema-{env.command or \'none\'}/**/*.py",\n'
        "    }\n"
        ")\n",
        encoding="utf-8",
    )

    resolved = load_config(config_file, ChxConfigEnv(command="generate"))
    assert resolved.schema_ == ["./schema-generate/**/*.py"]

    resolved_default = load_config(config_file)
    assert resolved_default.schema_ == ["./schema-none/**/*.py"]


# ---------- load_config: user profile layering ----------


def _write_project(tmp_path: Path, body: str) -> Path:
    config_file = tmp_path / "project" / "clickhouse.config.py"
    config_file.parent.mkdir()
    config_file.write_text(body, encoding="utf-8")
    return config_file


def _write_profile(xdg: Path, body: str) -> None:
    profile = xdg / "chkit" / USER_PROFILE_CONFIG_FILE
    profile.parent.mkdir(parents=True)
    profile.write_text(body, encoding="utf-8")


def test_load_config_layers_profile_under_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """TS parity (runtime/config.ts): the profile is merged under the project."""
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_profile(
        xdg,
        "config = {\n"
        '    "outDir": "./profile-out",\n'
        '    "safety": {"allowDestructive": True},\n'
        '    "clickhouse": {"url": "http://profile:8123", "password": "p", "database": "profile_db"},\n'
        "}\n",
    )
    config_file = _write_project(
        tmp_path,
        "config = {\n"
        '    "schema": "./schema/**/*.py",\n'
        '    "outDir": "./project-out",\n'
        '    "clickhouse": {"url": "http://project:8123", "database": "project_db"},\n'
        "}\n",
    )

    resolved = load_config(config_file)

    assert resolved.schema_ == ["./schema/**/*.py"]
    assert resolved.out_dir == "./project-out"
    assert resolved.safety.allow_destructive is True
    assert resolved.clickhouse is not None
    assert resolved.clickhouse.url == "http://project:8123"
    assert resolved.clickhouse.database == "project_db"
    assert resolved.clickhouse.password == "p"


def test_load_config_profile_clickhouse_applies_when_project_has_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_profile(
        xdg,
        "config = lambda env: {\n"
        '    "clickhouse": {"url": "http://profile:8123", "database": env.command},\n'
        "}\n",
    )
    config_file = _write_project(tmp_path, 'config = {"schema": "./schema/**/*.py"}\n')

    resolved = load_config(config_file, ChxConfigEnv(command="status"))

    assert resolved.clickhouse is not None
    assert resolved.clickhouse.url == "http://profile:8123"
    assert resolved.clickhouse.database == "status"


def test_load_config_without_profile_reads_only_the_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    config_file = _write_project(tmp_path, 'config = {"schema": "./schema/**/*.py"}\n')

    resolved = load_config(config_file)

    assert resolved.clickhouse is None
    assert resolved.out_dir == "./chkit"


def test_load_config_invalid_profile_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """As in TS, a profile that cannot be read fails the command."""
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_profile(xdg, 'settings = {"outDir": "./x"}\n')
    config_file = _write_project(tmp_path, 'config = {"schema": "./schema/**/*.py"}\n')

    with pytest.raises(AttributeError, match="must export a `config` attribute"):
        load_config(config_file)


@pytest.mark.parametrize(
    "profile_body",
    [
        "from chkit import define_config\n"
        'config = define_config({"clickhouse": {"url": "http://profile:8123", "password": "p"}})\n',
        "from chkit.core.model import ChxUserClickHouseConfig, ChxUserConfig\n"
        "config = ChxUserConfig(\n"
        '    clickhouse=ChxUserClickHouseConfig(url="http://profile:8123", password="p")\n'
        ")\n",
    ],
    ids=["define_config", "ChxUserConfig"],
)
def test_load_config_profile_model_may_leave_out_schema(
    profile_body: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """As in TS, ``schema`` is optional, so a profile built as a model may omit it."""
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_profile(xdg, profile_body)
    config_file = _write_project(tmp_path, 'config = {"schema": "./schema/**/*.py"}\n')

    resolved = load_config(config_file)

    assert resolved.schema_ == ["./schema/**/*.py"]
    assert resolved.clickhouse is not None
    assert resolved.clickhouse.url == "http://profile:8123"
    assert resolved.clickhouse.password == "p"


def test_load_config_project_without_schema_resolves_to_no_globs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """TS parity (resolveConfig): a missing ``schema`` resolves to ``[]``."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    config_file = _write_project(tmp_path, 'config = {"outDir": "./out"}\n')

    resolved = load_config(config_file)

    assert resolved.schema_ == []
    assert resolved.out_dir == "./out"
