"""Test the ``on_pull_introspect`` plugin hook.

When a plugin returns definitions from ``on_pull_introspect``, the pull
command should use them and skip the SQL-based path entirely (no
ClickHouseClient.connect() call).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.cli.plugin_runtime import PluginRuntime
from chkit.cli.table_scope import TableScope
from chkit.core.model import (
    ChxResolvedCheckConfig,
    ChxResolvedConfig,
    ChxResolvedSafetyConfig,
)
from chkit.plugins import (
    ChxOnPullIntrospectContext,
    ChxPlugin,
    ChxPluginManifest,
    LoadedPlugin,
)

CONFIG = """\
from chkit import define_config
from custom_introspector_plugin import custom_introspector

config = define_config(
    {
        "schema": "./schema.py",
        "outDir": "./chkit",
        "migrationsDir": "./chkit/migrations",
        "metaDir": "./chkit/meta",
        "clickhouse": {
            "url": "http://unused.local:8123",
            "username": "default",
            "password": "",
            "database": "default",
        },
        "plugins": [custom_introspector()],
    }
)
"""


def _install_custom_plugin_module(tmp_path: Path) -> None:
    """Drop a tiny plugin module on sys.path so the config can import it."""
    plugin_src = '''\
from chkit import ColumnDefinition, table
from chkit.plugins import ChxPlugin, ChxPluginManifest


class _Hooks:
    def on_pull_introspect(self, ctx):  # type: ignore[no-untyped-def]
        return [
            table(
                database="custom",
                name="generated",
                engine="MergeTree",
                columns=[ColumnDefinition(name="id", type="UInt64")],
                primary_key=["id"],
                order_by=["id"],
            )
        ]


def custom_introspector():
    return ChxPlugin(
        manifest=ChxPluginManifest(name="custom-introspector", api_version=1),
        hooks=_Hooks(),
    )
'''
    (tmp_path / "custom_introspector_plugin.py").write_text(plugin_src, encoding="utf-8")


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


def test_pull_uses_custom_introspector_and_skips_clickhouse(
    runner: CliRunner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    _install_custom_plugin_module(tmp_path)
    (tmp_path / "clickhouse.config.py").write_text(CONFIG, encoding="utf-8")
    (tmp_path / "schema.py").write_text(
        "from chkit import schema\ndefinitions = schema()\n", encoding="utf-8"
    )

    out_file = tmp_path / "pulled.py"

    with patch(
        "chkit.clickhouse.client.ClickHouseClient.connect"
    ) as mock_connect:
        result = runner.invoke(
            app,
            ["pull", "--out-file", str(out_file)],
            catch_exceptions=False,
        )

    assert result.exit_code == 0, result.output
    # The hook intercepted; ClickHouse should never have been contacted.
    mock_connect.assert_not_called()
    assert out_file.exists()
    content = out_file.read_text(encoding="utf-8")
    assert 'database="custom"' in content
    assert 'name="generated"' in content


def test_pull_writes_the_configured_index_granularity_for_a_table_without_one(
    runner: CliRunner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The custom introspector's table declares no index_granularity: the pulled
    # file gets clickhouse.indexGranularity, as in TS, not 8192 (#466).
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    _install_custom_plugin_module(tmp_path)
    config = CONFIG.replace('"database": "default",', '"database": "default",\n            "indexGranularity": 4096,')
    (tmp_path / "clickhouse.config.py").write_text(config, encoding="utf-8")
    (tmp_path / "schema.py").write_text(
        "from chkit import schema\ndefinitions = schema()\n", encoding="utf-8"
    )
    out_file = tmp_path / "pulled.py"

    with patch("chkit.clickhouse.client.ClickHouseClient.connect"):
        result = runner.invoke(app, ["pull", "--out-file", str(out_file)], catch_exceptions=False)

    assert result.exit_code == 0, result.output
    content = out_file.read_text(encoding="utf-8")
    assert '"index_granularity": 4096,' in content
    assert "8192" not in content


def test_pull_runtime_threads_through_when_hook_returns_none() -> None:
    """If on_pull_introspect returns None, runtime defers to next plugin / default."""

    class _NoOpHooks:
        def on_pull_introspect(self, _ctx: Any) -> None:
            return None

    plugin = ChxPlugin(
        manifest=ChxPluginManifest(name="noop", api_version=1),
        hooks=_NoOpHooks(),
    )
    runtime = PluginRuntime([LoadedPlugin(plugin=plugin, options={}, raw_options={})])
    cfg = ChxResolvedConfig(
        schema_=["s.py"],
        out_dir=".",
        migrations_dir=".",
        meta_dir=".",
        check=ChxResolvedCheckConfig(
            fail_on_pending=False, fail_on_checksum_mismatch=True, fail_on_drift=False
        ),
        safety=ChxResolvedSafetyConfig(allow_destructive=False),
    )
    ctx = ChxOnPullIntrospectContext(
        command="pull",
        config=cfg,
        table_scope=TableScope(enabled=False),
        flags={},
        clickhouse=None,
        databases=(),
    )
    assert runtime.run_on_pull_introspect(ctx) is None


def test_pull_writes_the_output_path_as_given_without_following_symlinks(
    runner: CliRunner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # As TS ``resolve(process.cwd(), outFile)``: the path is made absolute by
    # text, so a symlink is replaced rather than written through (#702).
    project = tmp_path / "project"
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "real").mkdir(parents=True)
    project.mkdir()
    (elsewhere / "target.py").write_text("# target\n", encoding="utf-8")
    (project / "link.py").symlink_to(elsewhere / "target.py")
    (project / "linkdir").symlink_to(elsewhere / "real")
    (project / "dangling.py").symlink_to(tmp_path / "nowhere" / "f.py")

    monkeypatch.chdir(project)
    monkeypatch.syspath_prepend(str(project))
    _install_custom_plugin_module(project)
    (project / "clickhouse.config.py").write_text(CONFIG, encoding="utf-8")
    (project / "schema.py").write_text(
        "from chkit import schema\ndefinitions = schema()\n", encoding="utf-8"
    )
    cwd = Path.cwd()

    def pull(out_file: str) -> str:
        with patch("chkit.clickhouse.client.ClickHouseClient.connect"):
            result = runner.invoke(
                app, ["pull", "--json", "--force", "--out-file", out_file], catch_exceptions=False
            )
        assert result.exit_code == 0, result.output
        return str(json.loads(result.stdout)["outFile"])

    # A symlinked output file is replaced by the pulled file; its target is untouched.
    assert pull(str(cwd / "link.py")) == str(cwd / "link.py")
    assert not (project / "link.py").is_symlink()
    assert 'name="generated"' in (project / "link.py").read_text(encoding="utf-8")
    assert (elsewhere / "target.py").read_text(encoding="utf-8") == "# target\n"

    # A dangling symlink is replaced too; nothing is created where it pointed.
    assert pull(str(cwd / "dangling.py")) == str(cwd / "dangling.py")
    assert (project / "dangling.py").is_file()
    assert not (project / "dangling.py").is_symlink()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["elsewhere", "project"]

    # A symlinked directory is reported as given and written through by the OS.
    assert pull("linkdir/s.py") == str(cwd / "linkdir" / "s.py")
    assert 'name="generated"' in (elsewhere / "real" / "s.py").read_text(encoding="utf-8")

    # `..` after a symlinked directory is taken by text, not from the link target.
    assert pull("linkdir/../x.py") == str(cwd / "x.py")
    assert 'name="generated"' in (project / "x.py").read_text(encoding="utf-8")
    assert sorted(p.name for p in elsewhere.iterdir()) == ["real", "target.py"]
