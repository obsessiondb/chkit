"""Port of ``packages/cli/src/test/obsessiondb-shared-engine-flags.test.ts`` and the
cfabb19 cases of ``packages/plugin-obsessiondb/src/index.test.ts``.

``--force-shared-engines`` / ``--no-shared-engines`` override the obsessiondb
plugin's host auto-detection on ``generate`` and ``snapshot rebuild`` (neither
connects to ClickHouse). The flags only decide whether storage_policy is
stripped.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from chkit.cli.main import app
from chkit.cli.table_scope import TableScope
from chkit.core import parse_flags
from chkit.core.model import ChxUserConfig, resolve_config, table
from chkit.plugins import ChxOnSchemaLoadedContext
from chkit_plugin_obsessiondb import obsessiondb, resolve_strip_behavior
from chkit_plugin_obsessiondb.plugin import _ObsessionDBHooks

LOCAL_URL = "http://localhost:8123"
OBSESSIONDB_URL = "https://flags-test.obsessiondb.com:8443"

SCHEMA = """from chkit import schema, table

events = table(
    database="app",
    name="events",
    columns=[{"name": "id", "type": "UInt64"}],
    engine="SharedMergeTree",
    primary_key=["id"],
    order_by=["id"],
    settings={"index_granularity": 8192, "storage_policy": "'s3'"},
)

definitions = schema(events)
"""


def _config(url: str) -> Any:
    return resolve_config(
        ChxUserConfig.model_validate(
            {
                "schema": "./schema.py",
                "clickhouse": {
                    "url": url,
                    "username": "default",
                    "password": "",
                    "database": "default",
                },
            }
        )
    )


def _override_flag_defs() -> list[dict[str, Any]]:
    extensions = obsessiondb().extend_commands or []
    entry = next(e for e in extensions if "generate" in e.get("command", []))
    flags = entry["flags"]
    assert isinstance(flags, list)
    return flags


# ---------- resolve_strip_behavior / plugin registration ----------


def test_reads_the_overrides_under_the_keys_the_flag_parser_produces() -> None:
    flag_defs = _override_flag_defs()

    assert (
        resolve_strip_behavior(_config(LOCAL_URL), parse_flags(["--force-shared-engines"], flag_defs))
        is False
    )
    assert (
        resolve_strip_behavior(
            _config("https://my-cluster.obsessiondb.com:8443"),
            parse_flags(["--no-shared-engines"], flag_defs),
        )
        is True
    )


def test_registers_the_override_flags_for_the_core_commands_and_snapshot() -> None:
    extensions = obsessiondb().extend_commands or []
    entry = next(e for e in extensions if "generate" in e.get("command", []))

    assert entry["command"] == ["generate", "migrate", "status", "drift", "check", "snapshot"]
    assert [flag["name"] for flag in entry["flags"]] == [
        "--force-shared-engines",
        "--no-shared-engines",
    ]


def test_describes_the_override_flags_by_the_setting_they_control() -> None:
    for flag in _override_flag_defs():
        assert "storage_policy" in flag["description"]
        assert "generate and snapshot rebuild" in flag["description"]
        assert "shared engine" not in flag["description"].lower()


def test_on_schema_loaded_honors_parsed_override_flags_for_storage_policy() -> None:
    hooks = _ObsessionDBHooks()
    flag_defs = _override_flag_defs()
    definitions = [
        table(
            database="app",
            name="events",
            columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree",
            primary_key=["id"],
            order_by=["id"],
            settings={"storage_policy": "'s3'"},
        )
    ]

    kept = hooks.on_schema_loaded(
        ChxOnSchemaLoadedContext(
            command="generate",
            table_scope=TableScope(enabled=False),
            config=_config(LOCAL_URL),
            flags=parse_flags(["--force-shared-engines"], flag_defs),
            definitions=definitions,
            json_mode=True,
        )
    )
    stripped = hooks.on_schema_loaded(
        ChxOnSchemaLoadedContext(
            command="generate",
            table_scope=TableScope(enabled=False),
            config=_config("https://my-cluster.obsessiondb.com:8443"),
            flags=parse_flags(["--no-shared-engines"], flag_defs),
            definitions=definitions,
            json_mode=True,
        )
    )

    assert kept is None
    assert stripped is not None
    assert stripped[0].settings is None


# ---------- CLI ----------


@pytest.fixture
def make_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.chdir(tmp_path)

    def make(url: str) -> Path:
        (tmp_path / "schema.py").write_text(SCHEMA, encoding="utf-8")
        (tmp_path / "clickhouse.config.py").write_text(
            "from chkit import define_config\n"
            "from chkit_plugin_obsessiondb import obsessiondb\n\n"
            "config = define_config({\n"
            '    "schema": "./schema.py",\n'
            '    "outDir": "./chkit",\n'
            '    "migrationsDir": "./chkit/migrations",\n'
            '    "metaDir": "./chkit/meta",\n'
            f'    "clickhouse": {{"url": "{url}", "username": "default", '
            '"password": "unused", "database": "default"},\n'
            '    "plugins": [obsessiondb()],\n'
            "})\n",
            encoding="utf-8",
        )
        return tmp_path

    return make


def _plan_create_table(flags: list[str]) -> str:
    result = CliRunner().invoke(app, ["generate", "--dryrun", "--json", *flags])
    assert result.exit_code == 0, result.output
    operations = json.loads(result.stdout)["operations"]
    create_table = next(op for op in operations if op["type"] == "create_table")
    sql = create_table["sql"]
    assert isinstance(sql, str)
    return sql


def test_auto_detection_strips_storage_policy_for_regular_clickhouse(make_project: Any) -> None:
    make_project(LOCAL_URL)

    sql = _plan_create_table([])

    assert "ENGINE = MergeTree()" in sql
    assert "storage_policy" not in sql


def test_force_shared_engines_keeps_storage_policy_for_regular_clickhouse(
    make_project: Any,
) -> None:
    make_project(LOCAL_URL)

    sql = _plan_create_table(["--force-shared-engines"])

    assert "ENGINE = MergeTree()" in sql
    assert "Shared" not in sql
    assert "storage_policy = 's3'" in sql


def test_auto_detection_keeps_storage_policy_for_an_obsessiondb_host(make_project: Any) -> None:
    make_project(OBSESSIONDB_URL)

    sql = _plan_create_table([])

    assert "ENGINE = MergeTree()" in sql
    assert "Shared" not in sql
    assert "storage_policy = 's3'" in sql


def test_no_shared_engines_strips_storage_policy_for_an_obsessiondb_host(
    make_project: Any,
) -> None:
    make_project(OBSESSIONDB_URL)

    sql = _plan_create_table(["--no-shared-engines"])

    assert "ENGINE = MergeTree()" in sql
    assert "storage_policy" not in sql


def test_a_later_generate_without_the_override_plans_a_storage_policy_change(
    make_project: Any,
) -> None:
    make_project(LOCAL_URL)
    first = CliRunner().invoke(
        app, ["generate", "--name", "init", "--json", "--force-shared-engines"]
    )
    assert first.exit_code == 0, first.output

    later = CliRunner().invoke(app, ["generate", "--dryrun", "--json"])

    assert later.exit_code == 0, later.output
    operations = [
        {"type": op["type"], "sql": op["sql"]} for op in json.loads(later.stdout)["operations"]
    ]
    assert operations == [
        {
            "type": "alter_table_reset_setting",
            "sql": "ALTER TABLE app.events RESET SETTING storage_policy;",
        }
    ]


def test_snapshot_rebuild_accepts_the_overrides_and_matches_generate(make_project: Any) -> None:
    project = make_project(LOCAL_URL)

    def rebuilt_settings(flags: list[str]) -> Any:
        result = CliRunner().invoke(app, ["snapshot", "rebuild", "--json", *flags])
        assert result.exit_code == 0, result.output
        snapshot = json.loads((project / "chkit/meta/snapshot.json").read_text(encoding="utf-8"))
        return next(d for d in snapshot["definitions"] if d["kind"] == "table").get("settings")

    assert rebuilt_settings([]) == {"index_granularity": 8192}
    assert rebuilt_settings(["--force-shared-engines"]) == {
        "index_granularity": 8192,
        "storage_policy": "'s3'",
    }


@pytest.mark.parametrize("command", ["migrate", "status", "drift", "check"])
@pytest.mark.parametrize("flag", ["--force-shared-engines", "--no-shared-engines"])
def test_other_core_commands_accept_and_ignore_the_overrides(
    tmp_path: Path, command: str, flag: str
) -> None:
    # As in TS: only generate and snapshot rebuild act on the flags, but the
    # other commands keep accepting them so existing scripts don't break.
    missing = tmp_path / "missing.config.py"
    result = CliRunner().invoke(app, [command, flag, "--config", str(missing)])

    assert "No such option" not in result.output
    assert result.exit_code != 2  # click's usage-error exit code
