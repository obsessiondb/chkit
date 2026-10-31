"""Tests for ``chkit.cli.user_config`` and ``chkit.cli.config_merge``."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.config_loader import (
    ProjectConfigRequiredError,
    load_config,
    loaded_config_path,
)
from chkit.cli.config_merge import merge_user_config, plugin_name_of
from chkit.cli.json_output import _reset_for_testing
from chkit.cli.main import app
from chkit.cli.user_config import (
    USER_CREDENTIALS_FILE,
    USER_PROFILE_CONFIG_FILE,
    get_user_config_dir,
    get_user_credentials_path,
    get_user_profile_config_path,
)
from chkit.core import SYNTHESIZED_CONFIG_PATH
from chkit.core.model import (
    ChxCheckConfig,
    ChxConfigEnv,
    ChxSafetyConfig,
    ChxUserClickHouseConfig,
    ChxUserConfig,
)
from chkit.plugins import ChxPlugin, ChxPluginManifest
from chkit_plugin_obsessiondb.storage import load_selected_service

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


# ---------- load_config: profile synthesized from ObsessionDB credentials ----------


def _write_credentials(xdg: Path) -> None:
    credentials = xdg / "chkit" / USER_CREDENTIALS_FILE
    credentials.parent.mkdir(parents=True)
    credentials.write_text('{"access_token": "fake-token"}', encoding="utf-8")


def _plugin_names(plugins: list[object]) -> list[str | None]:
    return [plugin_name_of(plugin) for plugin in plugins]


def test_load_config_credentials_register_obsessiondb_under_the_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """TS parity (readProfileLayer): no config.py but a login synthesizes a
    profile with only obsessiondb(), layered under the project."""
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_credentials(xdg)
    config_file = _write_project(tmp_path, 'config = {"schema": "./schema/**/*.py"}\n')

    resolved = load_config(config_file, ChxConfigEnv(command="status"))

    assert resolved.schema_ == ["./schema/**/*.py"]
    assert _plugin_names(resolved.plugins) == ["obsessiondb"]


def test_load_config_project_obsessiondb_wins_over_the_credentials_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_credentials(xdg)
    config_file = _write_project(
        tmp_path,
        "from chkit_plugin_obsessiondb import obsessiondb\n"
        "PROJECT_PLUGIN = obsessiondb()\n"
        'config = {"schema": "./schema/**/*.py", "plugins": [PROJECT_PLUGIN]}\n',
    )

    resolved = load_config(config_file)

    assert _plugin_names(resolved.plugins) == ["obsessiondb"]
    assert resolved.plugins[0] is sys.modules["chkit_user_config"].PROJECT_PLUGIN


def test_load_config_without_credentials_registers_no_plugin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    config_file = _write_project(tmp_path, 'config = {"schema": "./schema/**/*.py"}\n')

    assert load_config(config_file, ChxConfigEnv(command="status")).plugins == []


def test_load_config_profile_file_takes_precedence_over_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_profile(xdg, 'config = {"outDir": "./profile-out"}\n')
    (xdg / "chkit" / USER_CREDENTIALS_FILE).write_text("{}", encoding="utf-8")
    config_file = _write_project(tmp_path, 'config = {"schema": "./schema/**/*.py"}\n')

    resolved = load_config(config_file)

    assert resolved.out_dir == "./profile-out"
    assert resolved.plugins == []


# ---------- load_config: no project config ----------


def test_load_config_without_project_runs_query_from_the_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_credentials(xdg)
    monkeypatch.chdir(tmp_path)

    resolved = load_config(None, ChxConfigEnv(command="query"))

    assert resolved.schema_ == []
    assert _plugin_names(resolved.plugins) == ["obsessiondb"]


@pytest.mark.parametrize(
    "command",
    ["generate", "migrate", "status", "drift", "check", "snapshot", "codegen", "pull"],
)
def test_load_config_without_project_blocks_project_only_commands(
    command: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_credentials(xdg)
    monkeypatch.chdir(tmp_path)

    with pytest.raises(
        ProjectConfigRequiredError, match=f'Command "{command}" requires a project config'
    ):
        load_config(None, ChxConfigEnv(command=command))


def test_cli_project_only_command_without_project_reports_the_ts_error_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_credentials(xdg)
    monkeypatch.chdir(tmp_path)
    _reset_for_testing()

    result = CliRunner().invoke(app, ["status", "--json"])
    _reset_for_testing()

    assert result.exit_code == 1
    assert json.loads(result.stdout)["error"]["code"] == "project_config_required"


def test_load_config_without_project_or_profile_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.chdir(tmp_path)

    with pytest.raises(FileNotFoundError, match="no ObsessionDB profile is available"):
        load_config(None, ChxConfigEnv(command="query"))
    with pytest.raises(FileNotFoundError, match="Config file not found"):
        load_config(None, ChxConfigEnv(command="plugin"))


def test_load_config_explicit_missing_path_does_not_fall_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_credentials(xdg)

    with pytest.raises(FileNotFoundError, match="Config file not found"):
        load_config(tmp_path / "missing.config.py", ChxConfigEnv(command="query"))


def test_cli_plugin_obsessiondb_runs_without_project_or_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """TS allowsConfiglessObsessionDBBootstrap: `plugin obsessiondb` (and the
    `obsessiondb` shortcut) synthesize the profile so `login` can run."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    monkeypatch.chdir(tmp_path)

    listed = CliRunner().invoke(app, ["plugin", "obsessiondb"])
    assert listed.exit_code == 0, listed.output
    assert "Plugin: obsessiondb" in listed.stdout

    # Plain `chkit plugin` does not synthesize it, as in TS.
    listed_all = CliRunner().invoke(app, ["plugin"])
    assert listed_all.exit_code == 1
    assert isinstance(listed_all.exception, FileNotFoundError)


def test_loaded_config_path_reports_the_source_like_ts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """TS LoadedConfig.path: project, else profile file, else the synthesized
    path, so the profile's selected service lives in the user config dir."""
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    _write_credentials(xdg)
    (xdg / "chkit" / "obsessiondb.json").write_text(
        '{"service_slug": "svc", "service_name": "svc"}', encoding="utf-8"
    )
    monkeypatch.chdir(tmp_path)

    assert loaded_config_path() == SYNTHESIZED_CONFIG_PATH
    selected = load_selected_service(loaded_config_path())
    assert selected is not None
    assert selected.service_slug == "svc"
    assert loaded_config_path(Path("other.config.py")) == "other.config.py"

    (xdg / "chkit" / USER_PROFILE_CONFIG_FILE).write_text("config = {}\n", encoding="utf-8")
    assert loaded_config_path() == str(xdg / "chkit" / USER_PROFILE_CONFIG_FILE)

    (tmp_path / "clickhouse.config.py").write_text("config = {}\n", encoding="utf-8")
    assert loaded_config_path() == "clickhouse.config.py"


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
