"""``find_executed_chunks`` against the live target.

Port of ``packages/plugin-backfill/src/executed-chunks.e2e.test.ts``.
``submit --plan-id`` re-submits only the chunks of a plan that never finished
on the server (#313); this finds them by the header every chunk query starts
with, whatever query id or job ran them. Hard-fails when the server is
unreachable — never skips.
"""

from __future__ import annotations

import secrets
import threading
from datetime import UTC, datetime, timedelta

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from chkit_plugin_backfill.executed_chunks import ExecutedChunks, find_executed_chunks
from tests.e2e_testkit import create_prefix, poll_until, resolve_live_env

FINISHED = "a" * 16
FAILED = "b" * 16
RUNNING = "c" * 16
OTHER_PLAN_CHUNK = "d" * 16


def test_reports_the_finished_and_running_chunks_of_one_plan_only() -> None:
    env = resolve_live_env()
    config = ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=env.clickhouse_url.startswith("https"),
    )
    reader = ClickHouseClient.connect(config)
    runner = ClickHouseClient.connect(config)
    table = f"{env.clickhouse_database}.{create_prefix('executed_chunks')}t"
    plan_id = secrets.token_hex(8)
    other_plan_id = secrets.token_hex(8)
    since = (datetime.now(UTC) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")

    def header(plan: str, chunk: str) -> str:
        return f"/* chkit backfill plan={plan} chunk={chunk} token= */\n"

    def find() -> ExecutedChunks:
        return find_executed_chunks(executor=reader, plan_id=plan_id, since=since)

    try:
        reader.execute(f"CREATE TABLE {table} (id UInt64) ENGINE = MergeTree ORDER BY id")
        runner.execute(f"{header(plan_id, FINISHED)}INSERT INTO {table} SELECT number FROM numbers(3)")
        with pytest.raises(Exception, match="throwIf"):
            runner.execute(
                f"{header(plan_id, FAILED)}INSERT INTO {table}"
                " SELECT throwIf(number = 0) FROM numbers(3)"
            )
        runner.execute(
            f"{header(other_plan_id, OTHER_PLAN_CHUNK)}INSERT INTO {table}"
            " SELECT number FROM numbers(3)"
        )
        # Runs in the background: the request only returns once the INSERT finished.
        slow_insert = threading.Thread(
            target=runner.execute,
            args=(
                f"{header(plan_id, RUNNING)}INSERT INTO {table} SELECT number"
                " FROM numbers(10) WHERE sleepEachRow(1) = 0 SETTINGS max_block_size = 1",
            ),
        )
        slow_insert.start()

        while_running = poll_until(
            find,
            lambda value: FINISHED in value.finished and RUNNING in value.running,
            timeout=8.0,
        )
        assert while_running == ExecutedChunks(finished=[FINISHED], running=[RUNNING])

        slow_insert.join()
        afterwards = poll_until(find, lambda value: RUNNING in value.finished, timeout=30.0)
        assert afterwards == ExecutedChunks(finished=[FINISHED, RUNNING], running=[])
    finally:
        reader.execute(f"DROP TABLE IF EXISTS {table} SYNC")
        reader.close()
        runner.close()
