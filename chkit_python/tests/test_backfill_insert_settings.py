"""Backfill ``insertSettings``: per-chunk INSERT settings from ``backfill({...})``.

Port of the TS change that renders ``PluginConfig.insertSettings`` into the
single ``SETTINGS`` clause of every chunk ``INSERT … SELECT`` (ClickHouse
rejects a second SETTINGS clause there), for both the local executor and the
ObsessionDB managed submit. The e2e test runs the rendered INSERT against the
live server; it hard-fails when ClickHouse is unreachable.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.clickhouse.ddl_propagation import wait_for_table
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.chunking.sql import build_chunk_execution_sql
from chkit_plugin_backfill.chunking.types import Chunk, TableProfile
from chkit_plugin_backfill.options import PluginConfig
from chkit_plugin_backfill.planner import BuildBackfillPlanOutput
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
        "SETTINGS async_insert=0, insert_deduplication_token='tok'"
    )
    assert _settings_line(without_token) == "SETTINGS async_insert=0"


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
        "SETTINGS async_insert=0, insert_deduplication_token='tok', "
        "max_insert_threads=4, min_insert_block_size_rows=1000000, "
        "log_comment='it\\'s chkit', insert_deduplicate=true, "
        "max_partitions_per_insert_block=0, ratio=0.5, whole_float=2"
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
        "SETTINGS async_insert=0, max_insert_threads=2, insert_deduplicate=false"
    )


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
    assert sql.endswith("SETTINGS async_insert=0, max_insert_threads=8")


# ---------- plugin options ----------


def test_plugin_config_accepts_insert_settings_by_alias_and_field_name() -> None:
    by_alias = PluginConfig.model_validate(
        {"insertSettings": {"max_insert_threads": 4, "log_comment": "x", "flag": True}}
    )
    by_name = PluginConfig.model_validate({"insert_settings": {"max_insert_threads": 4}})

    assert by_alias.insert_settings == {"max_insert_threads": 4, "log_comment": "x", "flag": True}
    assert isinstance(by_alias.insert_settings["flag"], bool)
    assert by_name.insert_settings == {"max_insert_threads": 4}


def test_plugin_config_rejects_non_scalar_insert_settings() -> None:
    with pytest.raises(ValueError, match="insertSettings"):
        PluginConfig.model_validate({"insertSettings": {"max_insert_threads": [1, 2]}})


# ---------- ObsessionDB managed submit ----------


def test_build_submit_tasks_renders_the_insert_settings() -> None:
    tasks = build_submit_tasks(make_plan(), {"max_insert_threads": 4})

    for task in tasks:
        assert task.sql.count("SETTINGS") == 1
        assert task.sql.endswith(", max_insert_threads=4")


def test_handle_submit_uses_the_backfill_plugin_insert_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    submitted: list[dict[str, Any]] = []
    monkeypatch.setattr(
        backfill_submit_module, "create_remote_executor", lambda _creds, *, service_slug: None
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
        plugins=[backfill({"insertSettings": {"max_insert_threads": 6}})]
    )

    code = handle_submit(
        SubmitContext(
            flags={"--target": "app.events"},
            config_path="cfg.py",
            json_mode=False,
            config=config,
            print=lambda _value: None,
            credentials=Credentials(access_token="tok", base_url="https://api.test"),
            service_slug="svc-1",
        )
    )

    assert code == 0
    [call] = submitted
    assert all(task.sql.endswith(", max_insert_threads=6") for task in call["tasks"])


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
            # enable_parallel_replicas=0: ObsessionDB enables parallel replicas by
            # default, and the `_partition_id` filter can then miss freshly
            # inserted parts. Exactly the kind of setting insertSettings is for.
            insert_settings={
                "enable_parallel_replicas": 0,
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
