"""Zero-downtime cutover of a sort-key change (#202) under concurrent writers.

Port of ``packages/cli/src/test/cutover.e2e.test.ts``: against the local stack,
or ObsessionDB when ``CLICKHOUSE_URL`` / ``CLICKHOUSE_HOST`` point at it. The
2-shard cluster runs the same scenarios in
``tests_cluster/test_cutover_cluster_e2e.py``. An unreachable server fails the
test.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from chkit.clickhouse.client import ClickHouseClient
from chkit.core.model import ChxResolvedClickHouseConfig
from tests.cutover_scenario import (
    CutoverTarget,
    run_backfill_scenario,
    run_keep_scenario,
    run_retry_scenario,
)
from tests.e2e_testkit import resolve_live_env


@pytest.fixture
def target(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[CutoverTarget]:
    env = resolve_live_env()
    remote = env.clickhouse_url.startswith("https")
    config = ChxResolvedClickHouseConfig(
        url=env.clickhouse_url,
        username=env.clickhouse_user,
        password=env.clickhouse_password,
        database=env.clickhouse_database,
        secure=remote,
    )
    admin = ClickHouseClient.connect(config)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CI", "1")
    # create_cutover_project sets it; monkeypatch restores it afterwards.
    monkeypatch.setenv("CHKIT_JOURNAL_TABLE", "")
    database = env.clickhouse_database
    yield CutoverTarget(
        database=database,
        connection={
            "url": env.clickhouse_url,
            "username": env.clickhouse_user,
            "password": env.clickhouse_password,
            "database": database,
        },
        admin=admin,
        writer_configs=[config, config],
        engine="MergeTree",
        rows_of=lambda table: f"{database}.{table}",
        # A SharedMergeTree replica reads the parts every replica committed.
        read_settings=" SETTINGS select_sequential_consistency = 1" if remote else "",
    )
    admin.close()


def test_keeps_every_row_and_the_dependent_views_while_writers_insert(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_keep_scenario(target, "cutover_keep", tmp_path)


def test_copies_through_the_backfill_plugin_then_swaps_and_drops_the_old_table(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_backfill_scenario(target, "cutover_backfill", tmp_path)


def test_resumes_after_a_failure_at_every_step_and_never_replays_the_swap(
    target: CutoverTarget, tmp_path: Path
) -> None:
    run_retry_scenario(target, "cutover_retry", tmp_path)
