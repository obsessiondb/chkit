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
from chkit.core.flags import FlagDef
from chkit.core.model import (
    ChxUserConfig,
    MigrationOperation,
    MigrationPlan,
    _RiskSummary,
    resolve_config,
    table,
)
from chkit.plugins import ChxOnPlanCreatedContext, ChxOnSchemaLoadedContext
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
    settings={"index_granularity": 8192, "storage_policy": "STORAGE_POLICY"},
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


def _override_flag_defs() -> list[FlagDef]:
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
            settings={"storage_policy": "'hot_cold'"},
        )
    ]

    kept = hooks.on_schema_loaded(
        ChxOnSchemaLoadedContext(
            command="generate",
            table_scope=TableScope(enabled=False),
            config=_config(LOCAL_URL),
            flags=dict(parse_flags(["--force-shared-engines"], flag_defs)),
            definitions=definitions,
            json_mode=True,
        )
    )
    stripped = hooks.on_schema_loaded(
        ChxOnSchemaLoadedContext(
            command="generate",
            table_scope=TableScope(enabled=False),
            config=_config("https://my-cluster.obsessiondb.com:8443"),
            flags=dict(parse_flags(["--no-shared-engines"], flag_defs)),
            definitions=definitions,
            json_mode=True,
        )
    )

    # Kept as written: not a recognized ObsessionDB host, so no storage_policy rules apply.
    assert kept is None
    assert stripped is not None
    assert stripped[0].settings is None


def test_an_obsessiondb_target_gives_every_merge_tree_table_storage_policy_s3() -> None:
    # ObsessionDB writes storage_policy = 's3' into every Shared table, so pull
    # reads it back; on ObsessionDB the schema and the snapshot both carry it (#466).
    hooks = _ObsessionDBHooks()

    def events(name: str, settings: dict[str, Any] | None) -> Any:
        return table(
            database="app", name=name, columns=[{"name": "id", "type": "UInt64"}],
            engine="MergeTree", primary_key=["id"], order_by=["id"], settings=settings,
        )

    definitions = [
        events("events", {"index_granularity": "8192"}),
        events("pulled", {"storage_policy": "'s3'"}),
        events("hot", {"storage_policy": "'hot_cold'"}),
    ]

    def context(url: str, flags: dict[str, Any] | None = None) -> ChxOnSchemaLoadedContext:
        return ChxOnSchemaLoadedContext(
            command="generate", table_scope=TableScope(enabled=False), config=_config(url),
            flags=flags or {}, definitions=definitions, json_mode=True,
        )

    expected = [
        {"index_granularity": "8192", "storage_policy": "'s3'"},
        {"storage_policy": "'s3'"},
        {"storage_policy": "'hot_cold'"},
    ]
    obsession = "https://my-cluster.obsessiondb.com:8443"
    schema_side = hooks.on_schema_loaded(context(obsession))
    assert schema_side is not None
    assert [d.settings for d in schema_side] == expected
    assert [d.settings for d in hooks.on_snapshot_loaded(context(obsession))] == expected
    # Regular ClickHouse strips every storage_policy, on both sides.
    assert [d.settings for d in hooks.on_snapshot_loaded(context(LOCAL_URL))] == [
        {"index_granularity": "8192"},
        None,
        None,
    ]
    # --force-shared-engines on another host may be a self-hosted server with its
    # own policies: kept as is.
    forced = hooks.on_snapshot_loaded(context(LOCAL_URL, {"--force-shared-engines": True}))
    assert [d.settings for d in forced] == [d.settings for d in definitions]


def test_an_obsessiondb_target_rejects_a_plan_that_changes_storage_policy() -> None:
    hooks = _ObsessionDBHooks()
    plan = MigrationPlan(
        operations=[
            MigrationOperation(
                type="alter_table_modify_setting",
                key="table:app.events:setting:storage_policy",
                risk="caution",
                sql="ALTER TABLE app.events MODIFY SETTING storage_policy = 'hot_cold';",
            )
        ],
        risk_summary=_RiskSummary(caution=1),
        rename_suggestions=[],
    )

    def run(url: str) -> Any:
        return hooks.on_plan_created(
            ChxOnPlanCreatedContext(
                command="generate", table_scope=TableScope(enabled=False), config=_config(url),
                flags={}, plan=plan,
            )
        )

    with pytest.raises(ValueError, match=r"app\.events cannot change storage_policy"):
        run("https://my-cluster.obsessiondb.com:8443")
    assert run(LOCAL_URL) is None


# ---------- CLI ----------


@pytest.fixture
def make_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.chdir(tmp_path)

    def make(url: str, storage_policy: str | None = "'hot_cold'") -> Path:
        schema = (
            SCHEMA.replace(', "storage_policy": "STORAGE_POLICY"', "")
            if storage_policy is None
            else SCHEMA.replace("STORAGE_POLICY", storage_policy)
        )
        (tmp_path / "schema.py").write_text(schema, encoding="utf-8")
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
    assert "storage_policy = 'hot_cold'" in sql


def test_auto_detection_keeps_storage_policy_for_an_obsessiondb_host(make_project: Any) -> None:
    make_project(OBSESSIONDB_URL)

    sql = _plan_create_table([])

    assert "ENGINE = MergeTree()" in sql
    assert "Shared" not in sql
    assert "storage_policy = 'hot_cold'" in sql


def test_no_shared_engines_strips_storage_policy_for_an_obsessiondb_host(
    make_project: Any,
) -> None:
    make_project(OBSESSIONDB_URL)

    sql = _plan_create_table(["--no-shared-engines"])

    assert "ENGINE = MergeTree()" in sql
    assert "storage_policy" not in sql


def test_a_later_generate_without_the_override_plans_nothing_for_storage_policy(
    make_project: Any,
) -> None:
    make_project(LOCAL_URL)
    first = CliRunner().invoke(
        app, ["generate", "--name", "init", "--json", "--force-shared-engines"]
    )
    assert first.exit_code == 0, first.output

    later = CliRunner().invoke(app, ["generate", "--dryrun", "--json"])

    assert later.exit_code == 0, later.output
    # The plugin applies the same decision to the previous snapshot as to the
    # schema, so dropping the flag no longer plans a RESET the server rejects (#466).
    assert json.loads(later.stdout)["operations"] == []


def test_an_obsessiondb_host_gives_a_table_without_storage_policy_s3(make_project: Any) -> None:
    # Pull reads it back, so the schema, snapshot and CREATE carry it too (#466).
    make_project(OBSESSIONDB_URL, None)

    sql = _plan_create_table([])

    assert sql.endswith("SETTINGS index_granularity = 8192, storage_policy = 's3';")


def test_an_obsessiondb_host_rejects_a_storage_policy_change_in_generate(
    make_project: Any,
) -> None:
    project = make_project(OBSESSIONDB_URL, "'s3'")
    first = CliRunner().invoke(app, ["generate", "--name", "init", "--json"])
    assert first.exit_code == 0, first.output
    schema = project / "schema.py"
    schema.write_text(
        schema.read_text(encoding="utf-8").replace("\"'s3'\"", "\"'default'\""), encoding="utf-8"
    )

    changed = CliRunner().invoke(app, ["generate", "--dryrun", "--json"])

    assert changed.exit_code != 0
    assert "cannot change storage_policy" in changed.output


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
        "storage_policy": "'hot_cold'",
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
