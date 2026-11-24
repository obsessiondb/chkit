"""Backfill ``insertSettings``: per-chunk INSERT settings from ``backfill({...})``.

Port of the TS change that renders ``PluginConfig.insertSettings`` into the
single ``SETTINGS`` clause of every chunk ``INSERT … SELECT`` (ClickHouse
rejects a second SETTINGS clause there), for both the local executor and the
ObsessionDB managed submit. The e2e test runs the rendered INSERT against the
live server; it hard-fails when ClickHouse is unreachable.
"""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_table
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.chunking.sql import (
    PINNED_INSERT_SETTINGS_SQL as _PINNED_INSERT,
)
from chkit_plugin_backfill.chunking.sql import (
    assert_insert_settings_keep_pinned,
    build_chunk_execution_sql,
    delivery_override_warning,
    effective_insert_settings,
)
from chkit_plugin_backfill.chunking.types import Chunk, TableProfile
from chkit_plugin_backfill.errors import BackfillConfigError
from chkit_plugin_backfill.options import PluginConfig
from chkit_plugin_backfill.planner import (
    BuildBackfillPlanOutput,
    assert_pinned_insert_settings_accepted,
    read_pinned_setting_aliases,
)
from chkit_plugin_backfill.plugin import backfill
from chkit_plugin_obsessiondb import backfill_submit as backfill_submit_module
from chkit_plugin_obsessiondb.backfill_submit import (
    SubmitContext,
    build_submit_tasks,
    handle_submit,
)
from chkit_plugin_obsessiondb.credentials import Credentials
from tests.e2e_testkit import create_prefix, resolve_live_env, run_once_visible
from tests.test_obsessiondb_backfill_submit import make_plan

TABLE = TableProfile.model_validate(
    {
        "database": "app",
        "table": "events",
        "sortKeys": [
            {"name": "id", "type": "UInt64", "category": "numeric", "boundaryEncoding": "literal"}
        ],
    }
)


def _chunk(partition_id: str = "all") -> Chunk:
    return Chunk.model_validate(
        {
            "id": "c1",
            "partitionId": partition_id,
            "ranges": [],
            "estimate": {
                "rows": 1,
                "bytesCompressed": 1,
                "bytesUncompressed": 1,
                "confidence": "high",
                "reason": "partition-metadata",
            },
            "analysis": {"lineage": []},
        }
    )


PINNED = "asterisk_include_materialized_columns=0, asterisk_include_alias_columns=0"


def _settings_line(sql: str) -> str:
    return sql.splitlines()[-1]


# ---------- SETTINGS clause rendering ----------


def test_without_insert_settings_the_clause_is_unchanged() -> None:
    with_token = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events", table=TABLE, idempotency_token="tok"
    )
    without_token = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events", table=TABLE
    )

    assert _settings_line(with_token) == (
        f"SETTINGS async_insert=0, {PINNED}, insert_deduplication_token='tok', {_PINNED_INSERT}"
    )
    assert _settings_line(without_token) == f"SETTINGS async_insert=0, {PINNED}, {_PINNED_INSERT}"


def test_insert_settings_are_appended_to_the_single_settings_clause_in_order() -> None:
    sql = build_chunk_execution_sql(
        plan_id="p",
        chunk=_chunk(),
        target="app.events",
        table=TABLE,
        idempotency_token="tok",
        insert_settings={
            "max_insert_threads": 4,
            "min_insert_block_size_rows": 1_000_000,
            "log_comment": "it's chkit",
            "insert_deduplicate": True,
            "max_partitions_per_insert_block": 0,
            "ratio": 0.5,
            "whole_float": 2.0,
        },
    )

    assert sql.count("SETTINGS") == 1
    assert _settings_line(sql) == (
        "SETTINGS max_insert_threads=4, min_insert_block_size_rows=1000000, "
        "log_comment='it\\'s chkit', insert_deduplicate=true, "
        "max_partitions_per_insert_block=0, ratio=0.5, whole_float=2, "
        f"async_insert=0, {PINNED}, insert_deduplication_token='tok', {_PINNED_INSERT}"
    )


def test_insert_settings_without_a_token() -> None:
    sql = build_chunk_execution_sql(
        plan_id="p",
        chunk=_chunk(),
        target="app.events",
        table=TABLE,
        insert_settings={"max_insert_threads": 2, "insert_deduplicate": False},
    )

    assert _settings_line(sql) == (
        f"SETTINGS max_insert_threads=2, insert_deduplicate=false, async_insert=0, {PINNED}, "
        f"{_PINNED_INSERT}"
    )


_WRITTEN = (
    "async_insert=0, asterisk_include_materialized_columns=0, asterisk_include_alias_columns=0, "
    "insert_deduplication_token per chunk, allow_experimental_parallel_reading_from_replicas=0, "
    "parallel_distributed_insert_select=0, log_queries=1, log_queries_min_type='QUERY_START', "
    "log_queries_min_query_duration_ms=0, log_queries_probability=1"
)
_CUTOVER_WRITTEN = _WRITTEN.replace(
    "asterisk_include_alias_columns=0, ",
    "asterisk_include_alias_columns=0, insert_deduplicate=0, select_sequential_consistency=1, ",
)


def _refusal(named: str, written: str = _WRITTEN) -> str:
    return (
        f"insertSettings sets {named}, which chkit sets itself on every backfill chunk "
        f"INSERT ({written}): remove it from insertSettings."
    )


# Codex review r4: a setting chkit writes itself cannot be named in
# insertSettings, whatever the value: chkit's own is written last and wins.
@pytest.mark.parametrize(
    ("settings", "named"),
    [
        ({"log_queries": False}, "log_queries"),
        ({"log_queries": True}, "log_queries"),
        ({"parallel_distributed_insert_select": "00"}, "parallel_distributed_insert_select"),
        ({"log_queries_min_type": "QUERY_FINISH"}, "log_queries_min_type"),
        ({"log_queries_min_query_duration_ms": 0}, "log_queries_min_query_duration_ms"),
        ({"log_queries_probability": "1e0"}, "log_queries_probability"),
        (
            {"allow_experimental_parallel_reading_from_replicas": 0},
            "allow_experimental_parallel_reading_from_replicas",
        ),
        (
            {"enable_parallel_replicas": 0},
            "enable_parallel_replicas (an alias of "
            "allow_experimental_parallel_reading_from_replicas)",
        ),
        ({"async_insert": 0}, "async_insert"),
        ({"asterisk_include_alias_columns": True}, "asterisk_include_alias_columns"),
        ({"insert_deduplication_token": "shared"}, "insert_deduplication_token"),
    ],
)
def test_a_setting_chkit_writes_itself_is_refused_whatever_its_value(
    settings: dict[str, str | int | bool], named: str
) -> None:
    with pytest.raises(BackfillConfigError) as raised:
        build_chunk_execution_sql(
            plan_id="p", chunk=_chunk(), target="app.events", table=TABLE,
            idempotency_token="tok", insert_settings=settings,
        )

    assert str(raised.value) == _refusal(named)


# #821: the delivery pins are defaults; an override replaces the pin in place,
# under the pinned name, and turns a guarantee off, which a run warns about.
_DELIVERY_WARNING = {
    "distributed_foreground_insert": (
        "distributed_foreground_insert=0 (a chunk can be recorded done before its rows "
        "reach a Distributed table's shards)"
    ),
    "materialized_views_ignore_errors": (
        "materialized_views_ignore_errors=1 (a materialized view's failed write is "
        "dropped and the chunk is still recorded done)"
    ),
}


def _pins_without(*names: str) -> str:
    """The pins chkit writes after an override of the delivery pins ``names``."""
    return ", ".join(
        part for part in _PINNED_INSERT.split(", ") if part.split("=")[0] not in names
    )


@pytest.mark.parametrize(
    ("settings", "own", "pins", "warned"),
    [
        (
            {"distributed_foreground_insert": 0},
            "distributed_foreground_insert=0",
            _pins_without("distributed_foreground_insert"),
            ["distributed_foreground_insert"],
        ),
        (
            {"insert_distributed_sync": False},
            "distributed_foreground_insert=false",
            _pins_without("distributed_foreground_insert"),
            ["distributed_foreground_insert"],
        ),
        (
            {"materialized_views_ignore_errors": 1},
            "materialized_views_ignore_errors=1",
            _pins_without("materialized_views_ignore_errors"),
            ["materialized_views_ignore_errors"],
        ),
        (
            {"distributed_foreground_insert": 0, "materialized_views_ignore_errors": 1},
            "distributed_foreground_insert=0, materialized_views_ignore_errors=1",
            _pins_without("distributed_foreground_insert", "materialized_views_ignore_errors"),
            ["distributed_foreground_insert", "materialized_views_ignore_errors"],
        ),
    ],
)
def test_an_override_of_a_delivery_pin_replaces_it_and_warns(
    settings: dict[str, str | int | bool], own: str, pins: str, warned: list[str]
) -> None:
    sql = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events", table=TABLE,
        insert_settings={**settings, "max_insert_threads": 2},
    )

    assert _settings_line(sql) == (
        f"SETTINGS {own}, max_insert_threads=2, async_insert=0, {PINNED}, {pins}"
    )
    rendered = [
        _DELIVERY_WARNING[name].replace("=0", "=false")
        if "insert_distributed_sync" in settings
        else _DELIVERY_WARNING[name]
        for name in warned
    ]
    assert delivery_override_warning(settings) == (
        "Warning: insertSettings overrides what every backfill chunk INSERT sets by "
        f"default: {'; '.join(rendered)}."
    )


# Codex review r4: a delivery pin's value is always the user's, used as it
# is; only chkit's default in its plain forms gives no warning.
def test_the_default_or_a_delivery_pin_at_its_value_does_not_warn() -> None:
    assert delivery_override_warning(None) is None
    for settings in (
        {"distributed_foreground_insert": 1, "materialized_views_ignore_errors": "0"},
        {"insert_distributed_sync": True, "materialized_views_ignore_errors": False},
        {"distributed_foreground_insert": "TRUE", "materialized_views_ignore_errors": "False"},
        {"distributed_foreground_insert": "1", "max_insert_threads": 2},
    ):
        assert delivery_override_warning(settings) is None


def test_a_delivery_pin_in_another_form_is_used_as_it_is_and_warns() -> None:
    sql = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events", table=TABLE,
        insert_settings={"distributed_foreground_insert": "1.0"},
    )

    assert _settings_line(sql) == (
        f"SETTINGS distributed_foreground_insert='1.0', async_insert=0, {PINNED}, "
        + _pins_without("distributed_foreground_insert")
    )
    assert delivery_override_warning({"distributed_foreground_insert": "1.0"}) == (
        "Warning: insertSettings overrides what every backfill chunk INSERT sets by "
        "default: distributed_foreground_insert='1.0' (a chunk can be recorded done before "
        "its rows reach a Distributed table's shards)."
    )


def test_a_server_alias_of_a_delivery_pin_is_kept_under_the_pinned_name() -> None:
    aliases = {"foreground_alias": "distributed_foreground_insert"}
    settings = {"foreground_alias": 0, "max_insert_threads": 2}

    assert_insert_settings_keep_pinned(settings, aliases)
    effective = effective_insert_settings(settings, aliases)
    sql = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events", table=TABLE,
        insert_settings=effective,
    )

    assert effective == {"distributed_foreground_insert": 0, "max_insert_threads": 2}
    assert "foreground_alias" not in sql
    assert sql.count("distributed_foreground_insert=") == 1
    assert "distributed_foreground_insert=0" in sql


def test_a_delivery_pin_set_twice_is_refused() -> None:
    with pytest.raises(BackfillConfigError) as raised:
        assert_insert_settings_keep_pinned(
            {"distributed_foreground_insert": 1, "insert_distributed_sync": 1}
        )

    assert str(raised.value) == (
        "insertSettings sets distributed_foreground_insert more than once "
        "(distributed_foreground_insert, insert_distributed_sync). Keep one of them."
    )


def test_the_cutover_copy_carries_the_override_too() -> None:
    sql = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events_shadow", source_target="app.events",
        table=TABLE, target_columns=["id"], cutover_key=["id"],
        insert_settings={"distributed_foreground_insert": 0},
    )

    assert _settings_line(sql) == (
        f"SETTINGS distributed_foreground_insert=0, async_insert=0, {PINNED}, "
        "insert_deduplicate=0, select_sequential_consistency=1, "
        + _pins_without("distributed_foreground_insert")
    )


def test_the_preflight_checks_the_overridden_delivery_settings() -> None:
    reads: list[str] = []

    def query(sql: str, _settings: object = None) -> list[dict[str, object]]:
        reads.append(sql)
        return []

    assert_pinned_insert_settings_accepted(
        plan_id="p1", query=query,
        insert_settings=effective_insert_settings({"insert_distributed_sync": 0}),
    )

    assert reads == [
        f"SELECT 1 SETTINGS distributed_foreground_insert=0, async_insert=0, {PINNED}, "
        + _pins_without("distributed_foreground_insert")
    ]


def test_an_alias_the_server_lists_is_refused_too() -> None:
    aliases = {"log_queries_alias": "log_queries"}
    for value in (0, 1):
        with pytest.raises(BackfillConfigError) as raised:
            assert_insert_settings_keep_pinned({"log_queries_alias": value}, aliases)
        assert str(raised.value) == _refusal("log_queries_alias (an alias of log_queries)")
    kept = {"max_insert_threads": 4}
    assert_insert_settings_keep_pinned(kept, aliases)
    assert effective_insert_settings(kept, aliases) == kept


def test_the_server_aliases_come_from_system_settings_alias_for() -> None:
    reads: list[str] = []

    def query(sql: str, _settings: object = None) -> list[dict[str, object]]:
        reads.append(sql)
        return [{"name": "enable_parallel_replicas", "alias_for": "allow_experimental_parallel_reading_from_replicas"}]

    aliases = read_pinned_setting_aliases(query)

    assert aliases == {"enable_parallel_replicas": "allow_experimental_parallel_reading_from_replicas"}
    assert reads == [
        "SELECT name, alias_for FROM system.settings WHERE alias_for IN ("
        "'allow_experimental_parallel_reading_from_replicas', "
        "'parallel_distributed_insert_select', 'distributed_foreground_insert', 'materialized_views_ignore_errors', "
        "'log_queries', 'log_queries_min_type', "
        "'log_queries_min_query_duration_ms', 'log_queries_probability', 'async_insert', "
        "'asterisk_include_materialized_columns', 'asterisk_include_alias_columns', "
        "'insert_deduplicate', 'select_sequential_consistency', 'insert_deduplication_token')"
    ]


def test_a_server_without_alias_for_falls_back_to_the_static_aliases() -> None:
    def query(_sql: str, _settings: object = None) -> list[dict[str, object]]:
        raise RuntimeError("Missing columns: 'alias_for'")

    assert read_pinned_setting_aliases(query) == {}
    with pytest.raises(BackfillConfigError):
        assert_insert_settings_keep_pinned({"enable_parallel_replicas": 1}, {})


def test_insert_settings_apply_to_the_mv_replay_union_insert() -> None:
    sql = build_chunk_execution_sql(
        plan_id="p",
        chunk=_chunk(),
        target="app.events",
        table=TABLE,
        mv_replay_queries=["SELECT id FROM app.a", "SELECT id FROM app.b"],
        insert_settings={"max_insert_threads": 8},
    )

    assert sql.count("SETTINGS") == 1
    assert "UNION ALL" in sql
    assert sql.endswith(f"SETTINGS max_insert_threads=8, async_insert=0, {PINNED}, {_PINNED_INSERT}")


# ---------- plugin options ----------


def test_plugin_config_accepts_insert_settings_by_alias_and_field_name() -> None:
    by_alias = PluginConfig.model_validate(
        {"insertSettings": {"max_insert_threads": 4, "log_comment": "x", "flag": True}}
    )
    by_name = PluginConfig.model_validate({"insert_settings": {"max_insert_threads": 4}})

    assert by_alias.insert_settings == {"max_insert_threads": 4, "log_comment": "x", "flag": True}
    assert isinstance(by_alias.insert_settings["flag"], bool)
    assert by_name.insert_settings == {"max_insert_threads": 4}


@pytest.mark.parametrize("value", [float("nan"), float("inf")])
def test_plugin_config_rejects_a_non_finite_insert_setting(value: float) -> None:
    with pytest.raises(ValueError, match=r"insertSettings\.max_insert_threads must be a finite number"):
        PluginConfig.model_validate({"insertSettings": {"max_insert_threads": value}})


def test_plugin_config_rejects_non_scalar_insert_settings() -> None:
    with pytest.raises(ValueError, match="insertSettings"):
        PluginConfig.model_validate({"insertSettings": {"max_insert_threads": [1, 2]}})


# ---------- ObsessionDB managed submit ----------


def test_build_submit_tasks_renders_the_insert_settings() -> None:
    tasks = build_submit_tasks(make_plan(), {"max_insert_threads": 4})

    for task in tasks:
        assert task.sql.count("SETTINGS") == 1
        assert "SETTINGS max_insert_threads=4, async_insert=0, " in task.sql
        assert task.sql.endswith(f", {_PINNED_INSERT}")


def test_handle_submit_uses_the_backfill_plugin_insert_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    submitted: list[dict[str, Any]] = []
    monkeypatch.setattr(
        backfill_submit_module,
        "create_remote_executor",
        lambda _creds, *, service_slug: _FakeRemote({}),
    )
    monkeypatch.setattr(
        backfill_submit_module,
        "build_backfill_plan",
        lambda **_kwargs: BuildBackfillPlanOutput(
            plan=make_plan(), plan_path="/state/plans/abcdef0123456789.json"
        ),
    )

    def fake_jobs_submit(_creds: Credentials, **kwargs: Any) -> str:
        submitted.append(kwargs)
        return "job-1"

    monkeypatch.setattr(backfill_submit_module, "jobs_submit", fake_jobs_submit)
    config = SimpleNamespace(
        meta_dir="meta",
        plugins=[backfill({"insertSettings": {"max_insert_threads": 6}})],
    )

    code = handle_submit(
        SubmitContext(
            flags={"--target": "app.events"},
            config_path=str(tmp_path / "cfg.py"),
            json_mode=False,
            config=config,
            print=lambda _value: None,
            credentials=Credentials(access_token="tok", base_url="https://api.test"),
            service_slug="svc-1",
        )
    )

    assert code == 0
    [call] = submitted
    assert all(
        "SETTINGS max_insert_threads=6, async_insert=0, " in task.sql
        and task.sql.endswith(f", {_PINNED_INSERT}")
        for task in call["tasks"]
    )


class _FakeRemote:
    """The workbench a managed submit reads: the server's aliases of the
    compulsory settings, and the preflight ``SELECT 1``."""

    def __init__(self, aliases: dict[str, str]) -> None:
        self.aliases = aliases
        self.reads: list[str] = []

    def query(self, sql: str, _settings: object = None) -> SimpleNamespace:
        self.reads.append(sql)
        if "system.settings" in sql:
            return SimpleNamespace(
                rows=[{"name": name, "alias_for": to} for name, to in self.aliases.items()]
            )
        return SimpleNamespace(rows=[])


def _submit_with(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    insert_settings: dict[str, str | int | float | bool],
    remote: _FakeRemote,
) -> tuple[int, list[dict[str, Any]], list[object]]:
    submitted: list[dict[str, Any]] = []
    printed: list[object] = []
    monkeypatch.setattr(
        backfill_submit_module, "create_remote_executor", lambda _creds, *, service_slug: remote
    )
    monkeypatch.setattr(
        backfill_submit_module,
        "build_backfill_plan",
        lambda **_kwargs: BuildBackfillPlanOutput(
            plan=make_plan(), plan_path="/state/plans/abcdef0123456789.json"
        ),
    )

    def fake_jobs_submit(_creds: Credentials, **kwargs: Any) -> str:
        submitted.append(kwargs)
        return "job-1"

    monkeypatch.setattr(backfill_submit_module, "jobs_submit", fake_jobs_submit)
    code = handle_submit(
        SubmitContext(
            flags={"--target": "app.events"},
            config_path=str(tmp_path / "cfg.py"),
            json_mode=True,
            config=SimpleNamespace(
                meta_dir="meta", plugins=[backfill({"insertSettings": insert_settings})]
            ),
            print=printed.append,
            credentials=Credentials(access_token="tok", base_url="https://api.test"),
            service_slug="svc-1",
        )
    )
    return code, submitted, printed


def test_handle_submit_carries_a_delivery_override_and_warns_once(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    code, submitted, _printed = _submit_with(
        monkeypatch, tmp_path, {"materialized_views_ignore_errors": 1}, _FakeRemote({})
    )

    assert code == 0
    [call] = submitted
    pins = _pins_without("materialized_views_ignore_errors")
    assert all(
        "SETTINGS materialized_views_ignore_errors=1, async_insert=0, " in task.sql
        and task.sql.endswith(f", {pins}")
        for task in call["tasks"]
    )
    assert capsys.readouterr().err == (
        "Warning: insertSettings overrides what every backfill chunk INSERT sets by "
        f"default: {_DELIVERY_WARNING['materialized_views_ignore_errors']}.\n"
    )


# Codex review: a managed submit resolves the server's aliases like a local
# run, so an override through an alias only the server lists is honoured, and
# the server is asked first whether it accepts the settings.
def test_handle_submit_honours_a_server_alias_of_a_delivery_pin_and_preflights_it(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    remote = _FakeRemote({"foreground_alias": "distributed_foreground_insert"})
    code, submitted, _printed = _submit_with(
        monkeypatch, tmp_path, {"foreground_alias": 0}, remote
    )

    assert code == 0
    [call] = submitted
    pins = _pins_without("distributed_foreground_insert")
    for task in call["tasks"]:
        assert "foreground_alias" not in task.sql
        assert "SETTINGS distributed_foreground_insert=0, async_insert=0, " in task.sql
        assert task.sql.endswith(f", {pins}")
    assert (
        f"SELECT 1 SETTINGS distributed_foreground_insert=0, async_insert=0, {PINNED}, "
        f"insert_deduplication_token='chkit_preflight', {pins}"
        in remote.reads
    )
    assert capsys.readouterr().err == (
        "Warning: insertSettings overrides what every backfill chunk INSERT sets by "
        f"default: {_DELIVERY_WARNING['distributed_foreground_insert']}.\n"
    )


def test_handle_submit_refuses_a_server_alias_of_a_proof_pin(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    remote = _FakeRemote({"log_alias": "log_queries"})
    code, submitted, printed = _submit_with(monkeypatch, tmp_path, {"log_alias": 0}, remote)

    assert code == 1
    assert submitted == []
    assert printed == [
        {
            "ok": False,
            "command": "backfill submit",
            "error": _refusal("log_alias (an alias of log_queries)"),
        }
    ]


@pytest.mark.parametrize(
    "settings",
    [
        {"select_sequential_consistency": 1},
        {"insert_deduplicate": 0},
    ],
)
def test_a_setting_a_cutover_copy_writes_itself_is_refused(
    settings: dict[str, str | int | bool],
) -> None:
    [named] = settings
    with pytest.raises(BackfillConfigError) as raised:
        build_chunk_execution_sql(
            plan_id="p", chunk=_chunk(), target="app.events_shadow", source_target="app.events",
            table=TABLE, target_columns=["id"], cutover_key=["id"], insert_settings=settings,
        )

    assert str(raised.value) == _refusal(named, _CUTOVER_WRITTEN)


def test_insert_deduplicate_is_the_users_own_outside_a_cutover_copy() -> None:
    sql = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events", table=TABLE,
        insert_settings={"insert_deduplicate": 1, "max_insert_threads": 2},
    )

    assert _settings_line(sql) == (
        f"SETTINGS insert_deduplicate=1, max_insert_threads=2, async_insert=0, {PINNED}, "
        f"{_PINNED_INSERT}"
    )


# Codex review r2: the user's settings come first in the SETTINGS clause and
# everything chkit requires after them, so a later explicit setting wins over
# whatever the user's own settings set, a settings profile included
# (ClickHouse applies the clause in order; checked live on 26.3: `profile = p,
# log_comment = 'explicit'` reads 'explicit').
_FOREGROUND_OFF_PINS = _PINNED_INSERT.replace("distributed_foreground_insert=1, ", "")


def test_the_users_settings_come_first_and_what_chkit_requires_after_them() -> None:
    sql = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events", table=TABLE,
        idempotency_token="tok",
        insert_settings={"max_insert_threads": 2, "distributed_foreground_insert": 0},
    )

    assert _settings_line(sql) == (
        "SETTINGS max_insert_threads=2, distributed_foreground_insert=0, async_insert=0, "
        f"{PINNED}, insert_deduplication_token='tok', {_FOREGROUND_OFF_PINS}"
    )


def test_a_settings_profile_comes_before_every_setting_chkit_requires() -> None:
    copy = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events", table=TABLE,
        idempotency_token="tok", insert_settings={"profile": "batch"},
    )
    cutover = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events_shadow", source_target="app.events",
        table=TABLE, target_columns=["id"], cutover_key=["id"],
        insert_settings={"profile": "batch"},
    )

    assert _settings_line(copy) == (
        f"SETTINGS profile='batch', async_insert=0, {PINNED}, "
        f"insert_deduplication_token='tok', {_PINNED_INSERT}"
    )
    assert _settings_line(cutover) == (
        f"SETTINGS profile='batch', async_insert=0, {PINNED}, insert_deduplicate=0, "
        f"select_sequential_consistency=1, {_PINNED_INSERT}"
    )


# Codex review r2: the preflight tries every setting the chunks run with in
# the plan's mode, the user's own first.
def test_the_preflight_tries_every_setting_of_the_chunk_insert() -> None:
    reads: list[str] = []

    def query(sql: str, _settings: object = None) -> list[dict[str, object]]:
        reads.append(sql)
        return []

    assert_pinned_insert_settings_accepted(plan_id="p1", query=query)
    assert_pinned_insert_settings_accepted(
        plan_id="p1", query=query, insert_settings={"max_insert_threads": 2}, cutover=True
    )

    assert reads == [
        f"SELECT 1 SETTINGS async_insert=0, {PINNED}, {_PINNED_INSERT}",
        f"SELECT 1 SETTINGS max_insert_threads=2, async_insert=0, {PINNED}, "
        f"insert_deduplicate=0, select_sequential_consistency=1, {_PINNED_INSERT}",
    ]


# Codex review r3: a plan whose chunks carry a dedup token preflights one too,
# in the same place, so a constraint on the token fails before anything runs.
def test_the_preflight_of_a_token_bearing_plan_carries_a_token() -> None:
    reads: list[str] = []

    def query(sql: str, _settings: object = None) -> list[dict[str, object]]:
        reads.append(sql)
        return []

    assert_pinned_insert_settings_accepted(
        plan_id="p1", query=query, insert_settings={"max_insert_threads": 2}, token=True
    )

    assert reads == [
        f"SELECT 1 SETTINGS max_insert_threads=2, async_insert=0, {PINNED}, "
        f"insert_deduplication_token='chkit_preflight', {_PINNED_INSERT}"
    ]


# ---------- live ClickHouse ----------


def test_insert_with_insert_settings_runs_on_clickhouse() -> None:
    env = resolve_live_env()
    config = ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=env.clickhouse_url.startswith("https"),
    )
    prefix = create_prefix("bf_insert_settings")
    database = env.clickhouse_database
    source = f"{database}.{prefix}_src"
    target = f"{database}.{prefix}_dst"
    try:
        client = ClickHouseClient.connect(config)
        client.query("SELECT 1")
    except Exception as exc:  # never skip on an unreachable server
        pytest.fail(f"ClickHouse unreachable at {env.clickhouse_url}: {exc!r}", pytrace=False)

    try:
        for name in (source, target):
            client.execute(
                f"CREATE TABLE {name} (id UInt64, label String) ENGINE = MergeTree() ORDER BY id"
            )
        wait_for_table(client, database, f"{prefix}_src")
        wait_for_table(client, database, f"{prefix}_dst")
        run_once_visible(
            lambda: client.execute(
                f"INSERT INTO {source} SELECT number, toString(number) FROM numbers(500)"
            )
        )
        assert _poll_count(client, source, 500) == 500
        table = TableProfile.model_validate(
            {"database": database, "table": f"{prefix}_dst", "sortKeys": []}
        )

        sql = build_chunk_execution_sql(
            plan_id="p",
            chunk=_chunk("all"),
            target=target,
            source_target=source,
            table=table,
            idempotency_token=f"{prefix}-token",
            # The INSERT pins parallel replicas off itself, so the filter on
            # `_partition_id` sees every part ObsessionDB has.
            insert_settings={
                "max_insert_threads": 2,
                "min_insert_block_size_rows": 100,
                "log_comment": "chkit's backfill",
                "insert_deduplicate": True,
            },
        )
        # The INSERT may land on a replica that has not fetched the source parts
        # yet (eventual consistency). The idempotency token makes a re-run safe,
        # the same way a backfill retries a chunk.
        count = -1
        deadline = time.monotonic() + 60.0
        while count != 500 and time.monotonic() < deadline:
            client.execute(sql)
            count = _poll_count(client, target, 500, timeout_s=3.0)

        assert count == 500
    finally:
        for name in (source, target):
            client.execute(f"DROP TABLE IF EXISTS {name} SYNC")
        client.close()


def _poll_count(
    client: ClickHouseClient, table: str, expected: int, timeout_s: float = 30.0
) -> int:
    """State-based poll: replicas may serve the INSERTed parts a moment later."""
    deadline = time.monotonic() + timeout_s
    count = -1
    while time.monotonic() < deadline:
        count = int(str(client.query(f"SELECT count() AS c FROM {table}").rows[0]["c"]))
        if count == expected:
            return count
        time.sleep(0.25)
    return count


# Final check: a key that is not a setting name could smuggle a setting past
# the pinned-settings filter, and a value must never close its quote.
@pytest.mark.parametrize(
    "key",
    [" parallel_distributed_insert_select", "max_threads=1, parallel_distributed_insert_select"],
)
def test_an_insert_settings_key_that_is_not_a_setting_name_is_refused(key: str) -> None:
    with pytest.raises(BackfillConfigError) as raised:
        build_chunk_execution_sql(
            plan_id="p", chunk=_chunk(), target="app.events", table=TABLE,
            insert_settings={key: 2},
        )

    assert str(raised.value) == (
        f"insertSettings has a key that is not a setting name: {key!r}. A setting name is "
        "letters, digits and underscores, not starting with a digit."
    )


_INJECTION = "x\\', parallel_distributed_insert_select=2, log_comment='y"


def test_a_value_cannot_close_its_quote() -> None:
    sql = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events", table=TABLE,
        insert_settings={"log_comment": _INJECTION},
    )

    assert _settings_line(sql) == (
        "SETTINGS log_comment='x\\\\\\', parallel_distributed_insert_select=2, log_comment=\\'y', "
        f"async_insert=0, {PINNED}, {_PINNED_INSERT}"
    )


def test_clickhouse_reads_a_quote_breaking_value_as_one_string() -> None:
    env = resolve_live_env()
    config = ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=env.clickhouse_url.startswith("https"),
    )
    sql = build_chunk_execution_sql(
        plan_id="p", chunk=_chunk(), target="app.events", table=TABLE,
        insert_settings={"log_comment": _INJECTION},
    )
    settings = _settings_line(sql).removeprefix("SETTINGS ")
    client = ClickHouseClient.connect(config)
    try:
        rows = client.query(
            "SELECT getSetting('log_comment') AS comment, "
            f"getSetting('parallel_distributed_insert_select') AS pdis SETTINGS {settings}"
        ).rows
    finally:
        client.close()

    assert rows == [{"comment": _INJECTION, "pdis": 0}]
