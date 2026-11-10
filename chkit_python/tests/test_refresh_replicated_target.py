"""A refreshable view without APPEND on a Replicated target warns, as in TS
(``packages/cli/src/test/refresh-replicated-target.test.ts``)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app

SCHEMA = """from chkit import materialized_view, schema, table

rollup = table(database="app", name="daily_rollup", engine="MergeTree()",
               columns=[{"name": "day", "type": "Date"}], primary_key=["day"], order_by=["day"])
rollup_mv = materialized_view(database="app", name="daily_mv",
                              to={"database": "app", "name": "daily_rollup"},
                              refresh={"every": "1 HOUR"}, as_="SELECT today() AS day")
definitions = schema(rollup, rollup_mv)
"""

# The hook makes the target engine Replicated, with non-canonical padding.
PLUGIN = """from chkit.plugins import ChxPlugin, ChxPluginManifest


class Hooks:
    def on_schema_loaded(self, ctx):
        return [
            definition.model_copy(update={"engine": "  ReplicatedMergeTree  "})
            if definition.kind == "table"
            else definition
            for definition in ctx.definitions
        ]


plugin = ChxPlugin(manifest=ChxPluginManifest(name="engine-probe", api_version=1), hooks=Hooks())
"""


def test_generate_warns_when_a_plugin_hook_makes_the_target_replicated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "schema.py").write_text(SCHEMA, encoding="utf-8")
    (tmp_path / "engine_probe_plugin.py").write_text(PLUGIN, encoding="utf-8")
    (tmp_path / "clickhouse.config.py").write_text(
        f"""import sys
sys.path.insert(0, {str(tmp_path)!r})
from engine_probe_plugin import plugin

config = {{"schema": "./schema.py", "outDir": "./chkit", "plugins": [plugin]}}
""",
        encoding="utf-8",
    )

    result = CliRunner().invoke(app, ["generate", "--name", "init", "--json"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["migrationFile"]
    assert payload["warnings"] == [
        "Materialized view app.daily_mv refreshes a replicated target app.daily_rollup "
        "(ReplicatedMergeTree()) without APPEND. ClickHouse refuses this in a "
        "non-replicated database such as Atomic; ObsessionDB, ClickHouse Cloud and "
        "Replicated databases accept it. On a non-replicated database, set "
        "refresh.append = true or target a non-replicated table."
    ]
